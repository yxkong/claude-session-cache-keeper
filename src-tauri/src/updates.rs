use crate::{
    bridge::{self, BridgeRepository, Result},
    installer::{self, NativeRunner},
    release::{self, Source},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri_plugin_updater::UpdaterExt;
use tokio_util::sync::CancellationToken;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub fn plugin_version() -> String {
    serde_json::from_str::<Value>(include_str!("../../plugin/.claude-plugin/plugin.json")).unwrap()
        ["version"]
        .as_str()
        .unwrap()
        .into()
}
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}
pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}
pub struct NativeDownload {
    update: tauri_plugin_updater::Update,
    file: PathBuf,
}
pub struct Runtime {
    pub bridge: Mutex<BridgeRepository>,
    pub root: PathBuf,
    pub resources: PathBuf,
    pub demo: bool,
    pub source: Source,
    pub config: Value,
    pub status: Mutex<Value>,
    pub operation: AtomicBool,
    pub cancel: Mutex<CancellationToken>,
    catalog: Mutex<Value>,
    plugin_stage: Mutex<Option<PathBuf>>,
    app_download: Mutex<Option<PathBuf>>,
    native_download: Mutex<Option<NativeDownload>>,
    pub exit_allowed: AtomicBool,
    pub quit_running: AtomicBool,
    pub last_error: Mutex<Option<String>>,
}
pub struct Operation<'a>(&'a Runtime);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.operation.store(false, Ordering::SeqCst);
        self.0.patch(|s| s["progress"] = Value::Null);
    }
}
impl Runtime {
    pub fn new(
        bridge: BridgeRepository,
        root: PathBuf,
        resources: PathBuf,
        demo: bool,
    ) -> Result<Self> {
        let config: Value = serde_json::from_str(include_str!("../../release-config.json"))
            .map_err(|e| e.to_string())?;
        let source = Source::new(config["repository"].as_str().unwrap_or(""))?;
        let status = json!({"phase":"idle","repository":source.repository,"app":{"current":VERSION},"plugin":{"bundled":plugin_version()},"progress":null,"message":"按需检查，下载后由你决定何时安装。"});
        Ok(Self {
            bridge: Mutex::new(bridge),
            root,
            resources,
            demo,
            source,
            config,
            status: Mutex::new(status),
            operation: AtomicBool::new(false),
            cancel: Mutex::new(CancellationToken::new()),
            catalog: Mutex::new(Value::Null),
            plugin_stage: Mutex::new(None),
            app_download: Mutex::new(None),
            native_download: Mutex::new(None),
            exit_allowed: AtomicBool::new(false),
            quit_running: AtomicBool::new(false),
            last_error: Mutex::new(None),
        })
    }
    pub fn patch(&self, f: impl FnOnce(&mut Value)) {
        if let Ok(mut s) = self.status.lock() {
            f(&mut s);
        }
    }
    pub fn snapshot(&self) -> Value {
        self.status.lock().unwrap().clone()
    }
    pub fn state(&self) -> Result<Value> {
        let mut repo = self.bridge.lock().map_err(|_| "状态锁不可用")?;
        let rows = repo.refresh(bridge::now())?;
        let mut warnings = repo.warnings.clone();
        if let Some(e) = self.last_error.lock().unwrap().as_ref() {
            warnings.push(e.clone());
        }
        Ok(
            json!({"sessions":rows,"warnings":warnings,"version":VERSION,"executorVersion":plugin_version(),"platform":platform(),"arch":arch(),"demo":self.demo,"updates":self.snapshot()}),
        )
    }
    pub fn idle(&self) -> Result<()> {
        self.bridge.lock().map_err(|_| "状态锁不可用")?.idle()
    }
    pub fn begin(&self) -> Result<Operation<'_>> {
        if self
            .operation
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("正在处理更新或安装，请稍候。".into());
        }
        *self.cancel.lock().unwrap() = CancellationToken::new();
        Ok(Operation(self))
    }
    pub async fn install_bundled(&self) -> Result<String> {
        if self.demo {
            return Err("演示模式不安装真实插件。".into());
        }
        let _guard = self.begin()?;
        self.idle()?;
        let runner = NativeRunner;
        let cli = installer::find_cli(&runner).await?;
        installer::install(
            &self.resources.join("marketplace"),
            &self.root,
            &self.bridge,
            &cli,
            &runner,
        )
        .await
    }
    pub async fn update(self: &Arc<Self>, app: &tauri::AppHandle, action: &str) -> Result<Value> {
        if action == "cancel" {
            self.cancel.lock().unwrap().cancel();
            return Ok(self.snapshot());
        }
        if action == "release" {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(
                    format!("https://github.com/{}/releases", self.source.repository),
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?;
            return Ok(self.snapshot());
        }
        if action != "check" && self.demo {
            return Err("演示模式不会下载或安装真实更新。".into());
        }
        let _guard = self.begin()?;
        let cancel = self.cancel.lock().unwrap().clone();
        let result = match action {
            "check" => self.check(&cancel).await,
            "download-plugin" => self.download_plugin(&cancel).await,
            "apply-plugin" => self.apply_plugin().await,
            "download-app" => self.download_app(app, &cancel).await,
            "apply-app" => self.apply_app(app).await,
            _ => Err("无效的更新操作。".into()),
        };
        if let Err(e) = &result {
            self.patch(|s| {
                s["phase"] = json!("error");
                s["message"] = json!(e);
            });
        }
        result?;
        Ok(self.snapshot())
    }
    async fn check(&self, cancel: &CancellationToken) -> Result<()> {
        self.patch(|s| {
            s["phase"] = json!("checking");
            s["message"] = json!("正在检查 GitHub Release…");
        });
        let result = self.source.latest(cancel).await?;
        let m = &result["catalog"];
        let inspection = if self.demo {
            Ok(None)
        } else {
            async {
                let cli = installer::find_cli(&NativeRunner).await?;
                installer::installed(&cli, &NativeRunner).await
            }
            .await
        };
        let (installed, inspection_error) = match inspection {
            Ok(v) => (
                v.and_then(|p| {
                    p["version"]
                        .as_str()
                        .filter(|s| release::stable(s))
                        .map(str::to_owned)
                }),
                String::new(),
            ),
            Err(e) => (None, e),
        };
        let current_plugin = installed.clone().unwrap_or_else(plugin_version);
        let native = self.config["tauriUpdaterPublicKey"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
            && result["tauri"] == true
            && (platform() != "linux" || std::env::var_os("APPIMAGE").is_some());
        let downloadable = self.choose_asset(m, native).is_some();
        let gt = |a: &str, b: &str| {
            semver::Version::parse(a).unwrap() > semver::Version::parse(b).unwrap()
        };
        *self.catalog.lock().unwrap() = m.clone();
        *self.plugin_stage.lock().unwrap() = None;
        *self.app_download.lock().unwrap() = None;
        *self.native_download.lock().unwrap() = None;
        *self.status.lock().unwrap() = json!({"phase":"checked","repository":self.source.repository,"releaseURL":result["releaseURL"],"notes":result["notes"],"checkedAt":bridge::now(),"progress":null,
          "app":{"current":VERSION,"latest":m["app"]["version"],"available":gt(m["app"]["version"].as_str().unwrap(),VERSION),"downloadable":downloadable,"native":native,"ready":false},
          "plugin":{"current":installed,"inspectionError":inspection_error,"bundled":plugin_version(),"latest":m["plugin"]["version"],"available":gt(m["plugin"]["version"].as_str().unwrap(),&current_plugin),"compatible":!gt(m["plugin"]["minAppVersion"].as_str().unwrap(),VERSION),"minimumApp":m["plugin"]["minAppVersion"],"ready":false},
          "message":"检查完成。插件安装后，目标会话仍需重载；正在运行的模块保持原版本。"});
        Ok(())
    }
    fn choose_asset(&self, m: &Value, native: bool) -> Option<Value> {
        let suffixes = match platform() {
            "darwin" => {
                if native {
                    vec![".app.tar.gz"]
                } else {
                    vec![".dmg", ".zip"]
                }
            }
            "win32" => vec![".exe", ".msi", ".zip"],
            _ => {
                if native {
                    vec![".AppImage"]
                } else {
                    vec![".deb", ".AppImage", ".tar.gz"]
                }
            }
        };
        for suffix in suffixes {
            if let Some(a) = m["app"]["assets"].as_array()?.iter().find(|a| {
                a["platform"] == platform()
                    && (a["arch"] == arch() || a["arch"] == "universal")
                    && a["file"].as_str().is_some_and(|s| s.ends_with(suffix))
            }) {
                return Some(a.clone());
            }
        }
        None
    }
    async fn download_plugin(&self, cancel: &CancellationToken) -> Result<()> {
        let s = self.snapshot();
        if s["plugin"]["available"] != true || s["plugin"]["compatible"] != true {
            return Err("插件不可更新，请先检查应用版本与兼容性。".into());
        }
        self.patch(|s| {
            s["phase"] = json!("downloading-plugin");
            s["progress"] = json!(0);
            s["plugin"]["ready"] = json!(false);
        });
        *self.plugin_stage.lock().unwrap() = None;
        let p = self.catalog.lock().unwrap()["plugin"].clone();
        let dir = self
            .root
            .join("updates")
            .join(uuid::Uuid::new_v4().to_string());
        let file = dir.join(p["file"].as_str().unwrap());
        self.source
            .download(&p, &file, cancel, |n| {
                self.patch(|s| s["progress"] = json!(n))
            })
            .await?;
        let files = release::bundle(&bridge::read_json(&file, 3 * 1024 * 1024)?, Some(&p))?;
        let stage = dir.join("marketplace");
        for (name, data) in files {
            bridge::private_write(&stage.join(name), &data)?;
        }
        *self.plugin_stage.lock().unwrap() = Some(stage);
        self.patch(|s| {
            s["plugin"]["ready"] = json!(true);
            s["phase"] = json!("downloaded");
            s["message"] = json!("插件包已校验。待任务完成、停止保活后，可安装更新。");
        });
        Ok(())
    }
    async fn apply_plugin(&self) -> Result<()> {
        if self.snapshot()["plugin"]["compatible"] != true {
            return Err("插件要求更高的应用版本，请先更新应用以满足兼容性。".into());
        }
        self.idle()?;
        let stage = self
            .plugin_stage
            .lock()
            .unwrap()
            .clone()
            .filter(|_| self.snapshot()["plugin"]["ready"] == true)
            .ok_or("请先下载并校验插件更新。")?;
        self.patch(|s| s["phase"] = json!("installing-plugin"));
        let cli = installer::find_cli(&NativeRunner).await?;
        self.idle()?;
        installer::install(&stage, &self.root, &self.bridge, &cli, &NativeRunner).await?;
        self.patch(|s|{s["plugin"]["current"]=s["plugin"]["latest"].clone();s["plugin"]["available"]=json!(false);s["plugin"]["ready"]=json!(false);s["phase"]=json!("installed");s["message"]=json!("插件已安装。请在目标 Claude 会话手动重载；若仍为旧版，待任务结束后重启 Claude。新连接默认关闭。");});
        Ok(())
    }
    async fn download_app(&self, app: &tauri::AppHandle, cancel: &CancellationToken) -> Result<()> {
        let s = self.snapshot();
        if s["app"]["available"] != true {
            return Err("没有当前系统的可用更新包，请查看发布页。".into());
        }
        let native = s["app"]["native"] == true;
        let m = self.catalog.lock().unwrap().clone();
        let asset = self
            .choose_asset(&m, native)
            .ok_or("没有当前系统的可用更新包，请查看发布页。")?;
        self.patch(|s| {
            s["phase"] = json!("downloading-app");
            s["progress"] = json!(0);
            s["app"]["ready"] = json!(false);
        });
        *self.app_download.lock().unwrap() = None;
        *self.native_download.lock().unwrap() = None;
        let update = if native {
            let updater = app
                .updater_builder()
                .pubkey(self.config["tauriUpdaterPublicKey"].as_str().unwrap())
                .endpoints(vec![format!(
                    "https://github.com/{}/releases/latest/download/tauri-latest.json",
                    self.source.repository
                )
                .parse()
                .unwrap()])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let update=tokio::select!{r=updater.check()=>r.map_err(|e|e.to_string())?,_=cancel.cancelled()=>return Err("已取消下载。".into())}.ok_or("原生更新清单未提供此版本。")?;
            self.source.asset_url(update.download_url.as_str())?;
            if update.version != m["app"]["version"].as_str().unwrap()
                || Some(update.download_url.as_str()) != asset["url"].as_str()
            {
                return Err("原生更新与已校验清单不一致。".into());
            }
            Some(update)
        } else {
            None
        };
        let file = self
            .root
            .join("updates")
            .join(asset["file"].as_str().unwrap());
        self.source
            .download(&asset, &file, cancel, |n| {
                self.patch(|s| s["progress"] = json!(n))
            })
            .await?;
        if let Some(update) = update {
            let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
            update.verify(&bytes).map_err(|e| e.to_string())?;
            *self.native_download.lock().unwrap() = Some(NativeDownload { update, file });
        } else {
            *self.app_download.lock().unwrap() = Some(file);
        }
        self.patch(|s| {
            s["app"]["ready"] = json!(true);
            s["phase"] = json!("downloaded");
            s["message"] = json!(if native {
                "应用更新已下载并校验签名。待任务完成、停止保活后，可安装更新。"
            } else {
                "安装包已校验。此构建需手动安装，可打开下载目录替换应用。"
            });
        });
        Ok(())
    }
    async fn apply_app(&self, app: &tauri::AppHandle) -> Result<()> {
        if self.snapshot()["app"]["ready"] != true {
            return Err("请先下载应用更新。".into());
        }
        if self.snapshot()["app"]["native"] != true {
            let file = self
                .app_download
                .lock()
                .unwrap()
                .clone()
                .filter(|p| p.is_file())
                .ok_or("下载文件已移除，请重新下载。")?;
            tauri_plugin_opener::reveal_item_in_dir(file).map_err(|e| e.to_string())?;
            return Ok(());
        }
        self.idle()?;
        self.patch(|s| s["phase"] = json!("installing-app"));
        self.bridge.lock().unwrap().stop_all(false, bridge::now())?;
        let download = self
            .native_download
            .lock()
            .unwrap()
            .take()
            .ok_or("请重新下载应用更新。")?;
        let bytes = std::fs::read(&download.file).map_err(|e| e.to_string())?;
        let catalog = self.catalog.lock().unwrap().clone();
        let asset = self
            .choose_asset(&catalog, true)
            .ok_or("更新清单已失效。")?;
        if bytes.len() as u64 != asset["bytes"].as_u64().unwrap()
            || format!("{:x}", Sha256::digest(&bytes)) != asset["sha256"].as_str().unwrap()
        {
            return Err("缓存的应用更新校验失败，请重新下载。".into());
        }
        self.exit_allowed.store(true, Ordering::SeqCst);
        if let Err(e) = download.update.install(&bytes) {
            self.exit_allowed.store(false, Ordering::SeqCst);
            self.patch(|s| s["app"]["ready"] = json!(false));
            return Err(e.to_string());
        }
        app.restart();
    }
}
