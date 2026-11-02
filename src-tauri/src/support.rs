use crate::bridge::{self, Result};
use crate::release::Source;
use serde_json::{json, Value};
use std::path::Path;

pub const GUIDE_VERSION: u64 = 1;

pub fn product() -> Value {
    serde_json::from_str(include_str!("../../app/core/product.json"))
        .expect("invalid bundled product metadata")
}

pub fn guide_seen(root: &Path) -> bool {
    bridge::read_json(&root.join("ui-preferences.json"), 4096)
        .ok()
        .is_some_and(|v| {
            v["schema"] == 1 && v["guideVersion"].as_u64().unwrap_or(0) >= GUIDE_VERSION
        })
}

pub fn complete_guide(root: &Path) -> Result<()> {
    // UI preferences never write session controls, including in isolated demos.
    bridge::atomic_json(
        &root.join("ui-preferences.json"),
        &json!({"schema":1,"guideVersion":GUIDE_VERSION}),
    )
}

pub fn resource_url(resource: &str, repository: &str) -> Result<String> {
    let source = Source::new(repository)?;
    match resource {
        "repository" => Ok(format!("https://github.com/{}", source.repository)),
        "issues" => Ok(format!("https://github.com/{}/issues", source.repository)),
        "author" => Ok(format!(
            "https://github.com/{}",
            source.repository.split('/').next().unwrap()
        )),
        _ => Err("未知的产品链接。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn first_run_is_persisted_without_creating_controls() {
        let root = tempfile::tempdir().unwrap();
        assert!(!guide_seen(root.path()));
        complete_guide(root.path()).unwrap();
        assert!(guide_seen(root.path()));
        assert!(!root.path().join("controls").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        let other = tempfile::tempdir().unwrap();
        assert!(!guide_seen(other.path()), "demo roots must remain isolated");
    }

    #[test]
    fn invalid_or_older_preferences_show_guide_again() {
        let root = tempfile::tempdir().unwrap();
        for value in [
            "{",
            r#"{"schema":1,"guideVersion":0}"#,
            r#"{"schema":2,"guideVersion":1}"#,
        ] {
            fs::write(root.path().join("ui-preferences.json"), value).unwrap();
            assert!(!guide_seen(root.path()));
        }
    }

    #[test]
    fn preference_failure_is_reported() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("blocked");
        fs::write(&blocked, "synthetic").unwrap();
        assert!(complete_guide(&blocked).is_err());
    }

    #[test]
    fn product_links_accept_only_known_destinations() {
        let repo = "synthetic-owner/keeper";
        assert_eq!(
            resource_url("repository", repo).unwrap(),
            "https://github.com/synthetic-owner/keeper"
        );
        assert_eq!(
            resource_url("issues", repo).unwrap(),
            "https://github.com/synthetic-owner/keeper/issues"
        );
        assert_eq!(
            resource_url("author", repo).unwrap(),
            "https://github.com/synthetic-owner"
        );
        for resource in [
            "https://example.invalid",
            "file:///synthetic",
            "javascript:alert(1)",
            "",
        ] {
            assert!(resource_url(resource, repo).is_err());
        }
        assert!(resource_url("repository", "synthetic/repo/extra").is_err());
    }
}
