use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};
use uuid::Uuid;
pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 219
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn policy_contract() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| {
        serde_json::from_str(include_str!("../../build/resources/policy-contract.json"))
            .expect("generated policy contract")
    })
}
fn safe_integer(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}
pub fn valid_policy(p: &Value) -> bool {
    let c = &policy_contract()["limits"];
    ["minSeconds", "maxSeconds", "maxAttempts", "minCachedTokens"]
        .iter()
        .all(|k| safe_integer(&p[k]))
        && p["minSeconds"].as_f64().unwrap_or(-1.0) >= c["minSeconds"].as_f64().unwrap()
        && p["maxSeconds"].as_f64().unwrap_or(f64::MAX) <= c["maxSeconds"].as_f64().unwrap()
        && p["minSeconds"].as_f64() <= p["maxSeconds"].as_f64()
        && p["maxAttempts"].as_f64().unwrap_or(0.0) >= 1.0
        && p["minCachedTokens"].as_f64().unwrap_or(-1.0) >= 0.0
        && p["minCachedTokens"].as_f64().unwrap_or(f64::MAX)
            <= c["maxCachedTokens"].as_f64().unwrap()
}
pub fn online(s: &Value, at: u64) -> bool {
    s["active"] == true
        && s["heartbeat"]
            .as_f64()
            .is_some_and(|h| h > at as f64 - 10_000.0 && h <= at as f64 + 5000.0)
}
pub fn current(s: &Value) -> bool {
    s["bridgeProtocol"] == 1
        || (s.get("bridgeProtocol").is_none()
            && s["pluginVersion"].as_str().is_some_and(|v| {
                v.strip_prefix("0.2.")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            }))
}
pub fn valid_snapshot(s: &Value, id: &str) -> bool {
    s["schema"] == 1
        && s["id"] == id
        && valid_id(id)
        && s["sessionId"].as_str().is_some_and(valid_id)
        && ["title", "project", "model"]
            .iter()
            .all(|k| s[k].is_string())
        && s["enabled"].is_boolean()
        && s["active"].is_boolean()
        && s["heartbeat"].is_number()
        && valid_policy(&s["policy"])
        && safe_integer(&s["attempts"])
        && s["attempts"].as_f64().unwrap_or(-1.0) >= 0.0
        && [
            "nextAt",
            "lastCacheAt",
            "cacheTokens",
            "readTokens",
            "writeTokens",
            "outputTokens",
        ]
        .iter()
        .all(|k| s[k].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
}
pub fn read_json(path: &Path, limit: u64) -> Result<Value> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("状态文件过大。".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("状态文件过大。".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn private_write(path: &Path, data: &[u8]) -> Result<()> {
    private_dir(path.parent().ok_or("无效目录")?)?;
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
pub fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        private_write(&temp, format!("{}\n", value).as_bytes())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(temp);
    result
}
struct Row {
    snapshot: Value,
    root: PathBuf,
}
#[derive(Default)]
struct Title {
    path: PathBuf,
    size: u64,
    modified: Option<std::time::SystemTime>,
    value: Option<String>,
}
pub struct BridgeRepository {
    pub roots: Vec<PathBuf>,
    transcripts: PathBuf,
    rows: HashMap<String, Row>,
    titles: HashMap<String, Title>,
    pub warnings: Vec<String>,
}
impl BridgeRepository {
    pub fn new(roots: Vec<PathBuf>, transcripts: PathBuf) -> Self {
        Self {
            roots,
            transcripts,
            rows: HashMap::new(),
            titles: HashMap::new(),
            warnings: vec![],
        }
    }
    fn title(&mut self, id: &str) -> Option<String> {
        if !valid_id(id) {
            return None;
        }
        let cache = self.titles.entry(id.into()).or_default();
        if cache.path.as_os_str().is_empty() {
            for e in fs::read_dir(&self.transcripts).ok()?.flatten() {
                let path = e.path().join(format!("{id}.jsonl"));
                if e.file_type().ok()?.is_dir() && path.is_file() {
                    cache.path = path;
                    break;
                }
            }
        }
        let meta = fs::metadata(&cache.path).ok()?;
        let modified = meta.modified().ok();
        if meta.len() == cache.size && modified == cache.modified {
            return cache.value.clone();
        }
        let grew = cache.size > 0 && meta.len() >= cache.size;
        let start = meta.len().saturating_sub(8 * 1024 * 1024).max(if grew {
            cache.size.saturating_sub(4096)
        } else {
            0
        });
        let mut file = File::open(&cache.path).ok()?;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024).read_to_end(&mut bytes).ok()?;
        if !grew {
            cache.value = None;
        }
        for line in String::from_utf8_lossy(&bytes).lines().rev() {
            if !line.contains("custom-title") && !line.contains("agent-name") {
                continue;
            }
            if let Ok(row) = serde_json::from_str::<Value>(line) {
                let val = match row["type"].as_str() {
                    Some("custom-title") => row["customTitle"].as_str(),
                    Some("agent-name") => row["agentName"].as_str(),
                    _ => None,
                };
                if let Some(s) = val {
                    let clean: String = s.chars().map(|c| if c < ' ' { ' ' } else { c }).collect();
                    let clean: String = clean.trim().chars().take(120).collect();
                    if !clean.is_empty() {
                        cache.value = Some(clean);
                        break;
                    }
                }
            }
        }
        cache.size = meta.len();
        cache.modified = modified;
        cache.value.clone()
    }
    pub fn refresh(&mut self, at: u64) -> Result<Vec<Value>> {
        let first = self.roots.first().ok_or("缺少数据目录。")?;
        private_dir(&first.join("sessions"))?;
        private_dir(&first.join("controls"))?;
        self.warnings.clear();
        let mut seen = HashSet::new();
        for root in &self.roots {
            let entries = match fs::read_dir(root.join("sessions")) {
                Ok(e) => e,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        self.warnings.push("部分会话状态目录无法读取。".into());
                    }
                    continue;
                }
            };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".json") else {
                    continue;
                };
                if !valid_id(id) || seen.contains(id) {
                    continue;
                }
                if let Ok(s) = read_json(&e.path(), 64_000) {
                    if valid_snapshot(&s, id) {
                        self.rows.insert(
                            id.into(),
                            Row {
                                snapshot: s,
                                root: root.clone(),
                            },
                        );
                        seen.insert(id.to_owned());
                    }
                }
            }
        }
        let mut result = Vec::new();
        let ids: Vec<String> = self.rows.keys().cloned().collect();
        for id in ids {
            let row = &self.rows[&id];
            let mut s = row.snapshot.clone();
            let is_online = online(&s, at);
            let is_current = current(&s);
            let mut pending = false;
            if let Ok(c) = read_json(
                &row.root.join("controls").join(format!("{id}.json")),
                16_000,
            ) {
                if c["schema"] == 1
                    && c["id"] == id
                    && c["enabled"].is_boolean()
                    && c["revision"].is_string()
                    && valid_policy(&c["policy"])
                    && c["revision"] != s["controlRevision"]
                {
                    s["enabled"] = c["enabled"].clone();
                    s["policy"] = c["policy"].clone();
                    pending = true;
                }
            }
            s["pending"] = json!(pending);
            s["online"] = json!(is_online);
            s["current"] = json!(is_current);
            if let Some(title) = self.title(s["sessionId"].as_str().unwrap()) {
                s["title"] = json!(title);
            } else if s["title"] == "" {
                s["title"] = s["sessionId"].clone();
            }
            result.push(s);
        }
        result.sort_by(|a, b| {
            b["online"]
                .as_bool()
                .cmp(&a["online"].as_bool())
                .then_with(|| {
                    b["heartbeat"]
                        .as_f64()
                        .partial_cmp(&a["heartbeat"].as_f64())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        Ok(result)
    }
    pub fn save(&mut self, id: &str, input: &Value, at: u64) -> Result<Value> {
        if !valid_id(id) || !self.rows.contains_key(id) {
            return Err("找不到这条会话，请刷新后再试。".into());
        }
        if !input["enabled"].is_boolean() || !valid_policy(&input["policy"]) {
            return Err("间隔需为 30～280 秒的整数，最短不能大于最长；尝试次数需为正整数，token 门槛需为 0～1000 万的整数。".into());
        }
        let row = &self.rows[id];
        let latest = read_json(
            &row.root.join("sessions").join(format!("{id}.json")),
            64_000,
        )
        .unwrap_or_else(|_| row.snapshot.clone());
        if !valid_snapshot(&latest, id) {
            return Err("会话状态无效。".into());
        }
        if input["enabled"] == true && !online(&latest, at) {
            return Err("会话已离线，不能开启保活。".into());
        }
        if input["enabled"] == true && !current(&latest) {
            return Err("旧版执行器连接仅可停止；请更新插件并重新打开会话。".into());
        }
        if input["policy"]["maxAttempts"].as_f64().unwrap_or(0.0) > 6.0
            && latest["capabilities"]["customAttemptBudget"] != true
        {
            return Err("当前会话仍使用限制次数的旧执行器。请先安装新版连接插件，待任务结束后重载，再保存此设置。".into());
        }
        let c = json!({"schema":1,"id":id,"revision":Uuid::new_v4().to_string(),"enabled":input["enabled"],"policy":input["policy"]});
        atomic_json(&row.root.join("controls").join(format!("{id}.json")), &c)?;
        Ok(c)
    }
    pub fn stop_all(&mut self, legacy_only: bool, at: u64) -> Result<()> {
        let mut errors = Vec::new();
        for s in self.refresh(at)? {
            if s["enabled"] != true || (legacy_only && s["current"] == true) {
                continue;
            }
            if let Err(e) = self.save(
                s["id"].as_str().unwrap(),
                &json!({"enabled":false,"policy":s["policy"]}),
                at,
            ) {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!("部分会话未能停止：{}", errors.join("；")))
        }
    }
    pub fn idle(&mut self) -> Result<()> {
        if self.refresh(now())?.iter().any(|s| {
            s["online"] == true
                && (s["enabled"] == true || s["busy"] != false || s["inFlight"] != false)
        }) {
            Err("请等待 Claude 任务完成，并停止相关会话的保活后再安装更新。".into())
        } else {
            Ok(())
        }
    }
}
