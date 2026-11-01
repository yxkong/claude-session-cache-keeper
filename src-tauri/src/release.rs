use crate::bridge::{self, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
pub fn plugin_files() -> impl Iterator<Item = &'static str> {
    bridge::policy_contract()["pluginFiles"]
        .as_array()
        .expect("generated whitelist")
        .iter()
        .map(|v| v.as_str().unwrap())
}
pub fn stable(v: &str) -> bool {
    semver::Version::parse(v).is_ok_and(|s| s.pre.is_empty() && s.to_string() == v)
}
pub fn asset(a: &Value, limit: u64) -> Result<()> {
    let name = a["file"].as_str().ok_or("更新包名称无效")?;
    if name.is_empty()
        || name.len() > 181
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !a["bytes"].as_u64().is_some_and(|n| n > 0 && n <= limit)
        || !a["sha256"].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err("更新包地址、大小或校验值无效。".into());
    }
    Ok(())
}

pub fn catalog(m: &Value) -> Result<()> {
    if m["schema"] != 1
        || m["product"] != "io.yxkong.cachekeeper"
        || !m["app"]["version"].as_str().is_some_and(stable)
        || !m["app"]["assets"].as_array().is_some_and(|a| a.len() <= 30)
        || !m["plugin"]["version"].as_str().is_some_and(stable)
        || !m["plugin"]["minAppVersion"].as_str().is_some_and(stable)
        || m["plugin"]["bridgeProtocol"] != 1
    {
        return Err("更新清单版本或桥接协议不兼容。".into());
    }
    asset(&m["plugin"], 3 * 1024 * 1024)?;
    if m["plugin"]["file"]
        != format!(
            "CacheKeeper-plugin-{}.json",
            m["plugin"]["version"].as_str().unwrap()
        )
    {
        return Err("插件更新包名称无效。".into());
    }
    let mut names = HashSet::new();
    names.insert(m["plugin"]["file"].as_str().unwrap());
    for a in m["app"]["assets"].as_array().unwrap() {
        asset(a, 1024 * 1024 * 1024)?;
        let name = a["file"].as_str().unwrap();
        if !["darwin", "win32", "linux"].contains(&a["platform"].as_str().unwrap_or(""))
            || !["x64", "arm64", "universal"].contains(&a["arch"].as_str().unwrap_or(""))
            || !name.starts_with(&format!(
                "CacheKeeper-{}-",
                m["app"]["version"].as_str().unwrap()
            ))
            || !names.insert(name)
        {
            return Err("应用更新包平台或名称无效。".into());
        }
    }
    Ok(())
}
pub fn bundle(b: &Value, expected: Option<&Value>) -> Result<HashMap<String, Vec<u8>>> {
    if b["schema"] != 1
        || !b["version"].as_str().is_some_and(stable)
        || b["bridgeProtocol"] != 1
        || !b["minAppVersion"].as_str().is_some_and(stable)
        || b["files"].as_array().map(|a| a.len()) != Some(plugin_files().count())
        || expected.is_some_and(|e| {
            ["version", "bridgeProtocol", "minAppVersion"]
                .iter()
                .any(|k| b[k] != e[k])
        })
    {
        return Err("插件包版本或兼容性校验失败。".into());
    }
    let mut files = HashMap::new();
    let mut total = 0;
    for f in b["files"].as_array().unwrap() {
        let name = f["path"].as_str().unwrap_or("");
        let text = f["data"].as_str().ok_or("插件包文件内容无效。")?;
        if !plugin_files().any(|p| p == name)
            || files.contains_key(name)
            || text.len() > 4 * 1024 * 1024
        {
            return Err("插件包文件路径或内容无效。".into());
        }
        let data = STANDARD.decode(text).map_err(|_| "插件包文件内容无效。")?;
        if STANDARD.encode(&data) != text {
            return Err("插件包编码无效。".into());
        }
        total += data.len();
        if total > 2 * 1024 * 1024 {
            return Err("插件包超过大小限制。".into());
        }
        files.insert(name.to_string(), data);
    }
    let plugin: Value = serde_json::from_slice(&files["plugin/.claude-plugin/plugin.json"])
        .map_err(|e| e.to_string())?;
    let market: Value = serde_json::from_slice(&files[".claude-plugin/marketplace.json"])
        .map_err(|e| e.to_string())?;
    if plugin["name"] != "session-cache-keeper"
        || plugin["version"] != b["version"]
        || market["name"] != "yxkong-cache-tools"
        || market["plugins"].as_array().map(|p| p.len()) != Some(1)
        || market["plugins"][0]["name"] != plugin["name"]
        || market["plugins"][0]["source"] != "./plugin"
    {
        return Err("插件包身份校验失败。".into());
    }
    let re = regex::Regex::new(r#"\bpluginVersion:\s*['"]([^'"]+)['"]"#).unwrap();
    let register = String::from_utf8_lossy(&files["plugin/hooks/register.ts"]);
    if re
        .captures(&register)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        != b["version"].as_str()
    {
        return Err("插件报告的版本与发布版本不一致。".into());
    }
    Ok(files)
}
pub struct Source {
    pub repository: String,
    client: reqwest::Client,
    #[cfg(test)]
    pub test_origin: Option<String>,
}
impl Source {
    pub fn new(repository: &str) -> Result<Self> {
        if !regex::Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
            .unwrap()
            .is_match(repository)
        {
            return Err("尚未配置有效的 GitHub 更新仓库。".into());
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("CacheKeeper")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            repository: repository.into(),
            client,
            #[cfg(test)]
            test_origin: None,
        })
    }
    pub fn asset_url(&self, value: &str) -> Result<reqwest::Url> {
        let u = reqwest::Url::parse(value).map_err(|_| "更新包来源地址无效。")?;
        if u.scheme() != "https"
            || u.host_str() != Some("github.com")
            || !u.username().is_empty()
            || u.password().is_some()
            || u.port().is_some()
            || !u
                .path()
                .starts_with(&format!("/{}/releases/download/", self.repository))
        {
            return Err("更新包来源地址无效。".into());
        }
        Ok(u)
    }
    async fn request(
        &self,
        mut url: reqwest::Url,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<reqwest::Response> {
        for _ in 0..6 {
            #[cfg(test)]
            let target = self
                .test_origin
                .as_ref()
                .map(|base| format!("{}{}", base, url.path()))
                .unwrap_or_else(|| url.to_string());
            #[cfg(not(test))]
            let target = url.to_string();
            let response = tokio::select! {r=self.client.get(target).header("Accept","application/json").timeout(timeout).send()=>r.map_err(|e|e.to_string())?,_=cancel.cancelled()=>return Err("已取消下载，原版本保持可用。".into())};
            if [301, 302, 303, 307, 308].contains(&response.status().as_u16()) {
                let next = url
                    .join(
                        response
                            .headers()
                            .get("location")
                            .and_then(|h| h.to_str().ok())
                            .ok_or("更新包重定向来源无效。")?,
                    )
                    .map_err(|_| "更新包重定向来源无效。")?;
                if next.scheme() != "https"
                    || !next.username().is_empty()
                    || next.password().is_some()
                    || next.port().is_some()
                    || ![
                        "github.com",
                        "release-assets.githubusercontent.com",
                        "objects.githubusercontent.com",
                        "github-releases.githubusercontent.com",
                    ]
                    .contains(&next.host_str().unwrap_or(""))
                {
                    return Err("更新包重定向来源无效。".into());
                }
                url = next;
                continue;
            }
            match response.status().as_u16() {
                404 => return Err("尚未发布公开版本，或更新仓库不存在／不可访问。".into()),
                403 | 429 => return Err("GitHub 拒绝请求或达到频率限制，请稍后重试。".into()),
                200..=299 => return Ok(response),
                n => return Err(format!("更新请求失败（HTTP {n}）。")),
            }
        }
        Err("更新包重定向次数超过限制。".into())
    }
    async fn chunk(
        response: &mut reqwest::Response,
        cancel: &CancellationToken,
    ) -> Result<Option<bytes::Bytes>> {
        tokio::select! {r=response.chunk()=>r.map_err(|e|e.to_string()),_=cancel.cancelled()=>Err("已取消下载，原版本保持可用。".into())}
    }
    pub async fn json(&self, url: reqwest::Url, cancel: &CancellationToken) -> Result<Value> {
        let mut r = self.request(url, Duration::from_secs(30), cancel).await?;
        let mut data = Vec::new();
        while let Some(chunk) = Self::chunk(&mut r, cancel).await? {
            if data.len() + chunk.len() > 1024 * 1024 {
                return Err("更新清单超过大小限制。".into());
            }
            data.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&data).map_err(|e| e.to_string())
    }
    pub async fn latest(&self, cancel: &CancellationToken) -> Result<Value> {
        let release = self
            .json(
                reqwest::Url::parse(&format!(
                    "https://api.github.com/repos/{}/releases/latest",
                    self.repository
                ))
                .unwrap(),
                cancel,
            )
            .await?;
        if release["draft"] != false
            || release["prerelease"] != false
            || !release["assets"].is_array()
        {
            return Err("更新来源不是正式公开版本。".into());
        }
        let assets = release["assets"].as_array().unwrap();
        let manifest = assets
            .iter()
            .find(|a| a["name"] == "cachekeeper-update.json")
            .ok_or("该 Release 尚未提供完整的更新清单。")?;
        let mut m = self
            .json(
                self.asset_url(manifest["browser_download_url"].as_str().unwrap_or(""))?,
                cancel,
            )
            .await?;
        catalog(&m)?;
        if release["tag_name"] != format!("v{}", m["app"]["version"].as_str().unwrap()) {
            return Err("Release 标签与更新清单版本不一致。".into());
        }
        let mut all = m["app"]["assets"].as_array().unwrap().clone();
        all.push(m["plugin"].clone());
        for item in &mut all {
            let a = assets
                .iter()
                .find(|a| a["name"] == item["file"])
                .ok_or("Release 更新包缺失或大小不一致。")?;
            if a["size"] != item["bytes"] {
                return Err("Release 更新包缺失或大小不一致。".into());
            }
            let u = self.asset_url(a["browser_download_url"].as_str().unwrap_or(""))?;
            if u.path_segments().and_then(|mut s| s.next_back()) != item["file"].as_str() {
                return Err("更新包来源名称不一致。".into());
            }
            item["url"] = json!(u.as_str());
        }
        m["plugin"] = all.pop().unwrap();
        m["app"]["assets"] = json!(all);
        Ok(
            json!({"catalog":m,"releaseURL":format!("https://github.com/{}/releases/tag/{}",self.repository,release["tag_name"].as_str().unwrap()),"notes":release["body"].as_str().unwrap_or("").chars().take(8000).collect::<String>(),"tauri":assets.iter().any(|a|a["name"]=="tauri-latest.json")}),
        )
    }
    pub async fn download(
        &self,
        a: &Value,
        dest: &Path,
        cancel: &CancellationToken,
        progress: impl Fn(u64),
    ) -> Result<PathBuf> {
        asset(a, 1024 * 1024 * 1024)?;
        let url = self.asset_url(a["url"].as_str().unwrap_or(""))?;
        bridge::private_dir(dest.parent().ok_or("无效目录")?)?;
        let temp = dest.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
        let result: Result<()> = async {
            let mut r = self.request(url, Duration::from_secs(1200), cancel).await?;
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                options.mode(0o600);
            }
            let mut file = options.open(&temp).await.map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            let mut bytes = 0;
            let expected = a["bytes"].as_u64().unwrap();
            while let Some(chunk) = Self::chunk(&mut r, cancel).await? {
                bytes += chunk.len() as u64;
                if bytes > expected {
                    return Err("更新包大小校验失败。".into());
                }
                hash.update(&chunk);
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                progress(bytes * 100 / expected);
            }
            if bytes != expected
                || format!("{:x}", hash.finalize()) != a["sha256"].as_str().unwrap()
            {
                return Err("更新包大小或 SHA-256 校验失败。".into());
            }
            file.sync_all().await.map_err(|e| e.to_string())?;
            drop(file);
            tokio::fs::rename(&temp, dest)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        let _ = tokio::fs::remove_file(&temp).await;
        result?;
        Ok(dest.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn manifest() -> Value {
        json!({"schema":1,"product":"io.yxkong.cachekeeper","app":{"version":"0.5.0","assets":[]},"plugin":{"version":"0.2.2","minAppVersion":"0.3.0","bridgeProtocol":1,"file":"CacheKeeper-plugin-0.2.2.json","bytes":1,"sha256":"a".repeat(64)}})
    }
    #[test]
    fn release_protocol_paths_hashes_and_duplicates_are_enforced() {
        catalog(&manifest()).unwrap();
        for (field, value) in [
            ("bridgeProtocol", json!(2)),
            ("file", json!("../plugin.json")),
            ("sha256", json!("unverified")),
            ("minAppVersion", json!("latest")),
        ] {
            let mut m = manifest();
            m["plugin"][field] = value;
            assert!(catalog(&m).is_err());
        }
        let source = Source::new("synthetic-owner/cachekeeper").unwrap();
        for url in [
            "http://github.com/synthetic-owner/cachekeeper/releases/download/v1/a",
            "https://evil.invalid/a",
            "https://github.com/foreign/repo/releases/download/v1/a",
            "https://synthetic-user@github.com/synthetic-owner/cachekeeper/releases/download/v1/a",
        ] {
            assert!(source.asset_url(url).is_err());
        }
    }
    #[test]
    fn plugin_whitelist_identity_and_advertised_version_are_enforced() {
        let mut b = json!({"schema":1,"version":"0.2.2","minAppVersion":"0.3.0","bridgeProtocol":1,"files":plugin_files().map(|name|{
            let data=match name{"plugin/.claude-plugin/plugin.json"=>r#"{"name":"session-cache-keeper","version":"0.2.2"}"#,".claude-plugin/marketplace.json"=>r#"{"name":"yxkong-cache-tools","plugins":[{"name":"session-cache-keeper","source":"./plugin"}]}"#,"plugin/hooks/register.ts"=>"pluginVersion: '0.2.2'",_=>"synthetic"};json!({"path":name,"data":STANDARD.encode(data)})
        }).collect::<Vec<_>>()});
        assert_eq!(bundle(&b, None).unwrap().len(), 8);
        let original = b.clone();
        b["files"][0]["path"] = json!("../../settings.json");
        assert!(bundle(&b, None).is_err());
        b = original.clone();
        b["version"] = json!("0.2.3");
        assert!(bundle(&b, None).is_err());
        b = original;
        b["files"][1] = b["files"][0].clone();
        assert!(bundle(&b, None).is_err());
    }
    async fn server(
        routes: HashMap<String, (u16, Vec<u8>, Option<String>)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                    let n = stream.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                }
                let path = String::from_utf8_lossy(&request)
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                let (status, body, redirect) =
                    routes.get(&path).cloned().unwrap_or((404, vec![], None));
                let location = redirect
                    .map(|r| format!("Location: {r}\r\n"))
                    .unwrap_or_default();
                stream.write_all(format!("HTTP/1.1 {status} Test\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });
        (origin, task)
    }
    #[tokio::test]
    async fn corrupt_or_cancelled_download_preserves_previous_file_and_cleans_partial() {
        let (origin, task) = server(HashMap::from([(
            "/synthetic-owner/cachekeeper/releases/download/v0.5.0/app.dmg".into(),
            (200, b"corrupt".to_vec(), None),
        )]))
        .await;
        let mut source = Source::new("synthetic-owner/cachekeeper").unwrap();
        source.client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        source.test_origin = Some(origin);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app.dmg");
        std::fs::write(&file, "previous").unwrap();
        let a = json!({"file":"app.dmg","bytes":8,"sha256":format!("{:x}",Sha256::digest(b"expected")),"url":"https://github.com/synthetic-owner/cachekeeper/releases/download/v0.5.0/app.dmg"});
        assert!(source
            .download(&a, &file, &CancellationToken::new(), |_| {})
            .await
            .is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"previous");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(source.download(&a, &file, &cancel, |_| {}).await.is_err());
        task.abort();
    }
    #[tokio::test]
    async fn absent_release_and_foreign_redirect_are_errors_not_up_to_date() {
        let (origin, task) = server(HashMap::from([(
            "/redirect".into(),
            (302, vec![], Some("https://evil.invalid/payload".into())),
        )]))
        .await;
        let mut source = Source::new("synthetic-owner/cachekeeper").unwrap();
        source.client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        source.test_origin = Some(origin);
        assert!(source
            .latest(&CancellationToken::new())
            .await
            .unwrap_err()
            .contains("未发布"));
        assert!(source
            .request(
                "https://github.com/redirect".parse().unwrap(),
                Duration::from_secs(3),
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .contains("重定向"));
        task.abort();
    }
}
