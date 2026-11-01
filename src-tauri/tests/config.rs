use serde_json::Value;
#[test]
fn unsigned_build_configuration_is_accepted_by_the_actual_updater_plugin() {
    // Missing updater configuration deserializes as null and crashes at native startup.
    let raw: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(raw["plugins"]["updater"].clone()).unwrap();
    assert!(config.pubkey.is_empty());
    assert!(!config.allow_downgrades);
}
