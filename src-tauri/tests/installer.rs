use cachekeeper_lib::{
    bridge::BridgeRepository,
    installer::{self, Runner},
    release::plugin_files,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Mutex,
    time::Duration,
};
type Result<T> = std::result::Result<T, String>;
struct Fake {
    calls: Mutex<Vec<Vec<String>>>,
    listed: Value,
    fail: Option<&'static str>,
    disable_fails: bool,
}
impl Runner for Fake {
    fn run<'a>(
        &'a self,
        _exe: &'a Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(args.clone());
            if args[1] == "list" {
                return Ok(self.listed.to_string());
            }
            if self.fail == Some(args[1].as_str())
                || (self.disable_fails && args[1] == "disable" && args[2] == installer::PLUGIN_ID)
            {
                return Err("Synthetic CLI failure".into());
            }
            Ok("{\"outcome\":\"ok\"}".into())
        })
    }
}
fn fake(listed: Value, fail: Option<&'static str>) -> Fake {
    Fake {
        calls: Mutex::new(vec![]),
        listed,
        fail,
        disable_fails: false,
    }
}
fn resources(root: &Path) -> PathBuf {
    let resources = root.join("bundled");
    for name in plugin_files() {
        let file = resources.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            file,
            if name == "plugin/.claude-plugin/plugin.json" {
                "{\"name\":\"session-cache-keeper\",\"version\":\"0.2.2\"}"
            } else {
                "synthetic"
            },
        )
        .unwrap();
    }
    resources
}
fn repo(root: &Path) -> Mutex<BridgeRepository> {
    Mutex::new(BridgeRepository::new(
        vec![root.into()],
        root.join("transcripts"),
    ))
}
#[tokio::test]
async fn install_uses_stable_source_and_only_migrates_our_legacy_connector() {
    let dir = tempfile::tempdir().unwrap();
    let resources = resources(dir.path());
    let state = dir.path().join("user data");
    let runner = fake(
        json!([{"id":"unrelated@tools","enabled":true},{"id":"session-cache-keeper@personal-cache-tools","enabled":true}]),
        None,
    );
    installer::install(
        &resources,
        &state,
        &repo(&state),
        Path::new("synthetic-cli"),
        &runner,
    )
    .await
    .unwrap();
    let calls = runner.calls.lock().unwrap();
    let install = calls.iter().find(|a| a[1] == "install").unwrap();
    let index = install.iter().position(|a| a == "--marketplace").unwrap();
    assert_eq!(Path::new(&install[index + 1]), state.join("marketplace"));
    assert!(calls
        .iter()
        .any(|a| a[1] == "disable" && a[2] == "session-cache-keeper@personal-cache-tools"));
    assert!(!calls.iter().any(|a| a.contains(&"unrelated@tools".into())));
    assert_eq!(
        std::fs::read_to_string(state.join("marketplace/plugin/hooks/register.ts")).unwrap(),
        "synthetic"
    );
}
#[tokio::test]
async fn downgrade_is_rejected_before_any_cli_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let resources = resources(dir.path());
    let runner = fake(json!([{"id":installer::PLUGIN_ID,"version":"0.3.0"}]), None);
    assert!(installer::install(
        &resources,
        dir.path(),
        &repo(dir.path()),
        Path::new("synthetic-cli"),
        &runner
    )
    .await
    .unwrap_err()
    .contains("拒绝降级"));
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn failure_restores_marketplace_and_disables_new_before_restoring_legacy() {
    let dir = tempfile::tempdir().unwrap();
    let resources = resources(dir.path());
    let state = dir.path().join("state");
    std::fs::create_dir_all(state.join("marketplace")).unwrap();
    std::fs::write(state.join("marketplace/previous.txt"), "previous").unwrap();
    let runner = fake(
        json!([{"id":"session-cache-keeper@personal-cache-tools","enabled":true},{"id":installer::PLUGIN_ID,"enabled":false,"version":"0.2.0"}]),
        Some("update"),
    );
    assert!(installer::install(
        &resources,
        &state,
        &repo(&state),
        Path::new("synthetic-cli"),
        &runner
    )
    .await
    .is_err());
    assert_eq!(
        std::fs::read_to_string(state.join("marketplace/previous.txt")).unwrap(),
        "previous"
    );
    let calls = runner.calls.lock().unwrap();
    let disable = calls
        .iter()
        .position(|a| a[1] == "disable" && a[2] == installer::PLUGIN_ID)
        .unwrap();
    let enable = calls.iter().position(|a| a[1] == "enable").unwrap();
    assert!(disable < enable);
}
#[tokio::test]
async fn unconfirmed_new_disable_never_reenables_legacy() {
    let dir = tempfile::tempdir().unwrap();
    let resources = resources(dir.path());
    let mut runner = fake(
        json!([{"id":"session-cache-keeper@personal-cache-tools","enabled":true},{"id":installer::PLUGIN_ID,"enabled":false}]),
        Some("update"),
    );
    runner.disable_fails = true;
    let error = installer::install(
        &resources,
        dir.path(),
        &repo(dir.path()),
        Path::new("synthetic-cli"),
        &runner,
    )
    .await
    .unwrap_err();
    assert!(error.contains("旧版未重新开启"));
    assert!(!runner
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|a| a[1] == "enable"));
}
#[tokio::test]
async fn real_process_keeps_argument_boundaries_and_timeout_kills_child() {
    let exe_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/debug/examples/bridge-contract")
        .with_extension(if cfg!(windows) { "exe" } else { "" });
    let exe = exe_path.as_path();
    let value = "synthetic path with spaces & $(echo invalid)";
    let output = installer::run_cli(
        exe,
        vec!["--echo-args".into(), value.into()],
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!([value])
    );
    let error = installer::run_cli(exe, vec!["--wait".into()], Duration::from_millis(100))
        .await
        .unwrap_err();
    assert!(error.contains("超时"));
}
