use cachekeeper_lib::bridge::{atomic_json, BridgeRepository};
use serde_json::{json, Value};
use std::{fs, path::Path};
fn snapshot(id: &str) -> Value {
    json!({"schema":1,"id":id,"sessionId":format!("SID-{id}"),"pluginVersion":"0.2.1","bridgeProtocol":1,"title":"Synthetic","project":"/work/demo","model":"test","active":true,"heartbeat":1_000_000,"enabled":false,"controlRevision":"","capabilities":{"customAttemptBudget":true},"policy":{"minSeconds":260,"maxSeconds":280,"maxAttempts":6,"minCachedTokens":0},"attempts":0,"nextAt":0,"lastCacheAt":0,"cacheTokens":0,"phase":"off","busy":false,"inFlight":false,"readTokens":0,"writeTokens":0,"outputTokens":0})
}
fn write(root: &Path, id: &str, s: &Value) {
    atomic_json(&root.join("sessions").join(format!("{id}.json")), s).unwrap();
}
#[test]
fn only_selected_session_can_be_enabled_and_pending_settings_survive_refresh() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a", &snapshot("a"));
    write(dir.path(), "b", &snapshot("b"));
    let mut repo = BridgeRepository::new(vec![dir.path().into()], dir.path().join("transcripts"));
    assert_eq!(repo.refresh(1_000_000).unwrap().len(), 2);
    repo.save(
        "a",
        &json!({"enabled":true,"policy":snapshot("a")["policy"]}),
        1_000_000,
    )
    .unwrap();
    let c: Value =
        serde_json::from_slice(&fs::read(dir.path().join("controls/a.json")).unwrap()).unwrap();
    assert_eq!(c["enabled"], true);
    assert!(!dir.path().join("controls/b.json").exists());
    let rows = repo.refresh(1_000_000).unwrap();
    assert_eq!(
        rows.iter().find(|r| r["id"] == "a").unwrap()["pending"],
        true
    );
    repo.stop_all(false, 1_000_000).unwrap();
    assert_eq!(
        repo.refresh(1_000_000)
            .unwrap()
            .iter()
            .find(|r| r["id"] == "a")
            .unwrap()["enabled"],
        false
    );
}
#[test]
fn stale_unknown_traversal_and_invalid_budgets_cannot_enable() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a", &snapshot("a"));
    let mut repo = BridgeRepository::new(vec![dir.path().into()], dir.path().join("transcripts"));
    repo.refresh(1_000_000).unwrap();
    let input = json!({"enabled":true,"policy":snapshot("a")["policy"]});
    for id in ["../a", "missing"] {
        assert!(repo.save(id, &input, 1_000_000).is_err());
    }
    assert!(repo.save("a", &input, 1_060_000).is_err());
    for (field, n) in [
        ("maxAttempts", 0),
        ("minSeconds", 29),
        ("maxSeconds", 281),
        ("minCachedTokens", -1),
    ] {
        let mut bad = input.clone();
        bad["policy"][field] = json!(n);
        assert!(repo.save("a", &bad, 1_000_000).is_err());
    }
    assert!(!dir.path().join("controls/a.json").exists());
}
#[test]
fn partial_snapshot_title_metadata_and_custom_budget_capability_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = snapshot("a");
    s["capabilities"] = json!({});
    write(dir.path(), "a", &s);
    let transcript = dir.path().join("transcripts/project/SID-a.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    fs::write(&transcript,"{\"type\":\"custom-title\",\"customTitle\":\"正确名称\"}\n{\"type\":\"user\",\"message\":\"fake-title\"}\n").unwrap();
    let mut repo = BridgeRepository::new(vec![dir.path().into()], dir.path().join("transcripts"));
    assert_eq!(repo.refresh(1_000_000).unwrap()[0]["title"], "正确名称");
    let mut input = json!({"enabled":false,"policy":s["policy"]});
    input["policy"]["maxAttempts"] = json!(99);
    assert!(repo.save("a", &input, 1_000_000).is_err());
    s["capabilities"] = json!({"customAttemptBudget":true});
    write(dir.path(), "a", &s);
    repo.save("a", &input, 1_000_000).unwrap();
    fs::write(dir.path().join("sessions/a.json"), "{").unwrap();
    assert_eq!(repo.refresh(1_000_000).unwrap().len(), 1);
}
#[test]
fn rust_validation_matches_all_generated_typescript_boundary_cases() {
    for case in cachekeeper_lib::bridge::policy_contract()["cases"]
        .as_array()
        .unwrap()
    {
        assert_eq!(
            cachekeeper_lib::bridge::valid_policy(&case["policy"]),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["policy"]
        );
    }
}
#[test]
fn legacy_connections_can_stop_and_busy_or_unknown_work_blocks_installation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = snapshot("a");
    s["heartbeat"] = json!(cachekeeper_lib::bridge::now());
    s["pluginVersion"] = json!("0.1.2");
    s.as_object_mut().unwrap().remove("bridgeProtocol");
    s["enabled"] = json!(true);
    write(dir.path(), "a", &s);
    let mut repo = BridgeRepository::new(vec![dir.path().into()], dir.path().join("transcripts"));
    repo.refresh(cachekeeper_lib::bridge::now()).unwrap();
    let input = json!({"enabled":true,"policy":s["policy"]});
    assert!(repo
        .save("a", &input, cachekeeper_lib::bridge::now())
        .is_err());
    assert!(repo.idle().is_err());
    repo.stop_all(true, cachekeeper_lib::bridge::now()).unwrap();
    repo.idle().unwrap();
    s["enabled"] = json!(false);
    s["busy"] = json!(true);
    write(dir.path(), "a", &s);
    assert!(repo.idle().is_err());
    s.as_object_mut().unwrap().remove("busy");
    write(dir.path(), "a", &s);
    assert!(repo.idle().is_err());
}
