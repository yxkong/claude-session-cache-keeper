use crate::bridge::{self, BridgeRepository, Result};
use crate::release::plugin_files;
use serde_json::Value;
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Mutex,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use uuid::Uuid;
pub const PLUGIN_ID: &str = "session-cache-keeper@yxkong-cache-tools";
const LEGACY_ID: &str = "session-cache-keeper@personal-cache-tools";
pub trait Runner: Send + Sync {
    fn run<'a>(
        &'a self,
        exe: &'a Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>>;
}
pub struct NativeRunner;
impl Runner for NativeRunner {
    fn run<'a>(
        &'a self,
        exe: &'a Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(run_cli(exe, args, Duration::from_secs(30)))
    }
}
pub async fn run_cli(exe: &Path, args: Vec<String>, timeout: Duration) -> Result<String> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行 Claude Code CLI：{e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("无法读取 CLI 输出")?
        .take(512_001);
    let mut stderr = child
        .stderr
        .take()
        .ok_or("无法读取 CLI 输出")?
        .take(512_001);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let result = tokio::time::timeout(timeout, async {
        tokio::join!(
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err)
        )
    })
    .await;
    let (status, a, b) = match result {
        Ok(r) => r,
        Err(_) => {
            let _ = child.kill().await;
            return Err("CLI 执行超时，请检查 Claude Code 安装状态。".into());
        }
    };
    a.map_err(|e| e.to_string())?;
    b.map_err(|e| e.to_string())?;
    if out.len() + err.len() > 512_000 {
        return Err("CLI 输出超过限制。".into());
    }
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    if !status.map_err(|e| e.to_string())?.success() {
        return Err(text
            .chars()
            .rev()
            .take(1800)
            .collect::<String>()
            .chars()
            .rev()
            .collect());
    }
    Ok(text)
}
pub fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("找不到用户主目录。".into())
}
pub async fn find_cli(runner: &impl Runner) -> Result<PathBuf> {
    let home = home()?;
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend([home.join(".local/bin"), home.join(".bun/bin")]);
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    let names = if cfg!(windows) {
        vec!["claude.exe", "claude.cmd", "claude.bat"]
    } else {
        vec!["claude"]
    };
    for dir in dirs {
        for name in &names {
            let p = dir.join(name);
            if executable(&p) {
                return Ok(p);
            }
        }
    }
    #[cfg(not(windows))]
    for shell in if cfg!(target_os = "macos") {
        vec!["/bin/zsh", "/bin/bash"]
    } else {
        vec!["/bin/bash", "/bin/sh"]
    } {
        if let Ok(out) = run_cli(
            Path::new(shell),
            vec!["-lc".into(), "command -v claude".into()],
            Duration::from_secs(10),
        )
        .await
        {
            if let Some(line) = out.trim().lines().last() {
                let p = PathBuf::from(line);
                if p.is_absolute() && executable(&p) {
                    return Ok(p);
                }
            }
        }
    }
    let _ = runner;
    Err("未找到 Claude Code CLI。安装并登录 CLI 后再连接。".into())
}
fn executable(p: &Path) -> bool {
    let Ok(meta) = p.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
pub async fn installed(cli: &Path, runner: &impl Runner) -> Result<Option<Value>> {
    Ok(list(cli, runner)
        .await?
        .iter()
        .find(|p| p["id"] == PLUGIN_ID)
        .cloned())
}
async fn list(cli: &Path, runner: &impl Runner) -> Result<Vec<Value>> {
    let raw = runner
        .run(cli, vec!["plugin".into(), "list".into(), "--json".into()])
        .await?;
    serde_json::from_str::<Vec<Value>>(&raw).map_err(|_| "无法读取 CLI 插件列表。".into())
}
fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}
async fn confirmed(cli: &Path, runner: &impl Runner, a: Vec<String>) -> Result<()> {
    let text = runner.run(cli, a).await?;
    let result = text
        .lines()
        .rev()
        .find_map(|s| serde_json::from_str::<Value>(s).ok())
        .ok_or("连接插件未确认安装成功。")?;
    if result["outcome"] != "ok" {
        return Err(result["message"]
            .as_str()
            .unwrap_or("连接插件未确认安装成功。")
            .into());
    }
    Ok(())
}
struct Stage {
    dest: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
    previous: bool,
}
impl Stage {
    fn prepare(resources: &Path, root: &Path) -> Result<Self> {
        let stage = root
            .join("updates")
            .join(Uuid::new_v4().to_string())
            .join("marketplace");
        let dest = root.join("marketplace");
        let backup = stage.with_extension("previous");
        for name in plugin_files() {
            bridge::private_write(
                &stage.join(name),
                &std::fs::read(resources.join(name)).map_err(|e| e.to_string())?,
            )?;
        }
        let previous = match std::fs::rename(&dest, &backup) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.to_string()),
        };
        if let Err(e) = std::fs::rename(&stage, &dest) {
            if previous {
                std::fs::rename(&backup, &dest).map_err(|e| e.to_string())?;
            }
            return Err(e.to_string());
        }
        Ok(Self {
            dest,
            stage,
            backup,
            previous,
        })
    }
    fn finish(&self, success: bool) -> Result<()> {
        if success {
            if self.previous {
                std::fs::remove_dir_all(&self.backup).map_err(|e| e.to_string())?;
            }
        } else {
            std::fs::rename(&self.dest, &self.stage).map_err(|e| e.to_string())?;
            if self.previous {
                std::fs::rename(&self.backup, &self.dest).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
pub async fn install(
    resources: &Path,
    root: &Path,
    repo: &Mutex<BridgeRepository>,
    cli: &Path,
    runner: &impl Runner,
) -> Result<String> {
    let listed = list(cli, runner).await?;
    let legacy = listed
        .iter()
        .any(|p| p["id"] == LEGACY_ID && p["enabled"] == true);
    let existing = listed.iter().find(|p| p["id"] == PLUGIN_ID);
    let candidate =
        bridge::read_json(&resources.join("plugin/.claude-plugin/plugin.json"), 64_000)?;
    let version = semver::Version::parse(candidate["version"].as_str().unwrap_or(""))
        .map_err(|_| "插件版本无效。")?;
    if let Some(v) = existing
        .and_then(|p| p["version"].as_str())
        .and_then(|s| semver::Version::parse(s).ok())
    {
        if v > version {
            return Err("已安装的插件版本较新，拒绝降级。请使用“检查更新”获取新版。".into());
        }
    }
    let stage = Stage::prepare(resources, root)?;
    let result: Result<()> = async {
        if legacy {
            {
                repo.lock()
                    .map_err(|_| "状态锁不可用")?
                    .stop_all(true, bridge::now())?;
            }
            runner
                .run(
                    cli,
                    args(&["plugin", "disable", LEGACY_ID, "--scope", "user"]),
                )
                .await?;
        }
        let mut new_installed = false;
        let mutation: Result<()> = async {
            confirmed(
                cli,
                runner,
                vec![
                    "plugin".into(),
                    "install".into(),
                    "session-cache-keeper".into(),
                    "--marketplace".into(),
                    stage.dest.to_string_lossy().into_owned(),
                    "--scope".into(),
                    "user".into(),
                    "--json".into(),
                ],
            )
            .await?;
            new_installed = true;
            if existing.is_some() {
                confirmed(
                    cli,
                    runner,
                    args(&["plugin", "update", PLUGIN_ID, "--scope", "user", "--json"]),
                )
                .await?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = mutation {
            if legacy {
                let may_be_enabled = new_installed
                    || match list(cli, runner).await {
                        Ok(rows) => rows
                            .iter()
                            .any(|p| p["id"] == PLUGIN_ID && p["enabled"] != false),
                        Err(_) => true,
                    };
                if may_be_enabled {
                    {
                        repo.lock()
                            .map_err(|_| "状态锁不可用")?
                            .stop_all(false, bridge::now())?;
                    }
                    if runner
                        .run(
                            cli,
                            args(&["plugin", "disable", PLUGIN_ID, "--scope", "user"]),
                        )
                        .await
                        .is_err()
                    {
                        return Err(
                            "新版安装未完成，且未能确认停用；旧版未重新开启，请检查 CLI 插件状态。"
                                .into(),
                        );
                    }
                }
                if runner
                    .run(
                        cli,
                        args(&["plugin", "enable", LEGACY_ID, "--scope", "user"]),
                    )
                    .await
                    .is_err()
                {
                    return Err(format!("{error}；旧插件恢复失败，请检查 CLI 插件状态。"));
                }
            }
            return Err(error);
        }
        Ok(())
    }
    .await;
    stage.finish(result.is_ok())?;
    result?;
    Ok("连接插件已安装。请在目标会话重载插件；若仍报告旧版，待任务完成后重启 Claude。新连接默认关闭。".into())
}
