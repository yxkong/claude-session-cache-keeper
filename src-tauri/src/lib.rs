pub mod bridge;
pub mod installer;
pub mod release;
pub mod support;
mod updates;
use bridge::{BridgeRepository, Result};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::{Emitter, Manager};
use updates::Runtime;

fn trusted(window: &tauri::WebviewWindow) -> Result<()> {
    let u = window.url().map_err(|e| e.to_string())?;
    if window.label() != "main"
        || !((u.scheme() == "tauri" && u.host_str() == Some("localhost"))
            || (["http", "https"].contains(&u.scheme()) && u.host_str() == Some("tauri.localhost")))
    {
        return Err("请求不来自应用页面。".into());
    }
    Ok(())
}
#[tauri::command]
async fn keeper_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Runtime>>,
) -> Result<Value> {
    trusted(&window)?;
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.state())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn keeper_save(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Runtime>>,
    id: String,
    control: Value,
) -> Result<Value> {
    trusted(&window)?;
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut r = s.bridge.lock().map_err(|_| "状态锁不可用")?;
        if s.operation.load(Ordering::SeqCst) && control["enabled"] == true {
            return Err("正在安装更新，请稍后再开启保活。".into());
        }
        r.refresh(bridge::now())?;
        r.save(&id, &control, bridge::now())?;
        drop(r);
        s.state()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn keeper_stop_all(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Runtime>>,
) -> Result<Value> {
    trusted(&window)?;
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        s.bridge
            .lock()
            .map_err(|_| "状态锁不可用")?
            .stop_all(false, bridge::now())?;
        s.state()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn keeper_install(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Runtime>>,
) -> Result<String> {
    trusted(&window)?;
    state.install_bundled().await
}
#[tauri::command]
async fn keeper_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Runtime>>,
    action: String,
) -> Result<Value> {
    trusted(&window)?;
    state.inner().clone().update(&app, &action).await
}
#[tauri::command]
fn keeper_copy_reload(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<bool> {
    trusted(&window)?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text("/reload-plugins")
        .map_err(|e| e.to_string())?;
    Ok(true)
}
#[tauri::command]
fn keeper_open_docs(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    trusted(&window)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://code.claude.com/docs/en/discover-plugins",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn keeper_open_resource(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Runtime>>,
    resource: String,
) -> Result<()> {
    trusted(&window)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            support::resource_url(&resource, &state.source.repository)?,
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn keeper_copy_wechat(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    trusted(&window)?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(support::product()["wechatName"].as_str().unwrap())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn keeper_complete_guide(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Runtime>>,
) -> Result<()> {
    trusted(&window)?;
    support::complete_guide(&state.root)
}
#[tauri::command]
fn keeper_frontend_ready(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Runtime>>,
) -> Result<()> {
    trusted(&window)?;
    if state.demo && !state.root.join("ui-ready.json").exists() {
        let s = state.state()?;
        bridge::atomic_json(
            &state.root.join("ui-ready.json"),
            &json!({"version":updates::VERSION,"engine":"Tauri system WebView","sessions":s["sessions"].as_array().unwrap().len(),"demo":true}),
        )?;
        if std::env::var("CACHE_KEEPER_EXIT_AFTER_READY")
            .ok()
            .as_deref()
            == Some("1")
        {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                app.exit(0);
            });
        }
    }
    Ok(())
}
fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            keeper_state,
            keeper_save,
            keeper_install,
            keeper_stop_all,
            keeper_update,
            keeper_copy_reload,
            keeper_open_docs,
            keeper_open_resource,
            keeper_copy_wechat,
            keeper_complete_guide,
            keeper_frontend_ready
        ])
        .setup(|app| {
            let home = installer::home().map_err(std::io::Error::other)?;
            let isolated = std::env::var_os("CACHE_KEEPER_DATA_DIR").map(PathBuf::from);
            let demo = std::env::var("CACHE_KEEPER_DEMO").ok().as_deref() == Some("1");
            if demo && isolated.is_none() {
                return Err("演示模式必须指定隔离的数据目录。".into());
            }
            let root = isolated
                .clone()
                .unwrap_or_else(|| home.join(".cache-keeper"));
            if !root.is_absolute() {
                return Err("数据目录必须是绝对路径。".into());
            }
            let mut roots = vec![root.clone()];
            if cfg!(target_os = "macos") && isolated.is_none() {
                roots.push(home.join("Library/Application Support/ClaudeCacheKeeper"));
            }
            let transcripts = if demo {
                root.join("transcripts")
            } else {
                std::env::var_os("CLAUDE_CONFIG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".claude"))
                    .join("projects")
            };
            let resources = app.path().resource_dir()?.join("resources");
            let state = Arc::new(
                Runtime::new(
                    BridgeRepository::new(roots, transcripts),
                    root,
                    resources,
                    demo,
                )
                .map_err(std::io::Error::other)?,
            );
            state
                .bridge
                .lock()
                .unwrap()
                .refresh(bridge::now())
                .map_err(std::io::Error::other)?;
            app.manage(state);
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            let open = MenuItem::with_id(app, "open", "打开会话列表", true, None::<&str>)?;
            let update = MenuItem::with_id(app, "updates", "检查更新…", true, None::<&str>)?;
            let help = MenuItem::with_id(app, "help", "使用引导…", true, None::<&str>)?;
            let about = MenuItem::with_id(app, "about", "关于 CacheKeeper…", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "停止全部保活", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "停止全部并退出", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&open, &help, &about, &update, &stop, &separator, &quit],
            )?;
            let icon = if cfg!(target_os = "macos") {
                include_bytes!("../../assets/icons/tray-mac.png").as_slice()
            } else {
                include_bytes!("../../assets/icons/tray.png").as_slice()
            };
            tauri::tray::TrayIconBuilder::with_id("keeper")
                .icon(tauri::image::Image::from_bytes(icon)?)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("CacheKeeper · 会话缓存保活")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show(app),
                    "updates" => {
                        show(app);
                        let _ = app.emit("keeper:show-updates", ());
                    }
                    "quit" => app.exit(0),
                    "stop" => {
                        let state = app.state::<Arc<Runtime>>();
                        if let Err(e) = state.bridge.lock().unwrap().stop_all(false, bridge::now())
                        {
                            *state.last_error.lock().unwrap() = Some(e);
                            show(app);
                        };
                    }
                    _ => {}
                })
                .build(app)?;
            let native_menu = Menu::default(app.handle())?;
            // Replace the default OS About panel with the same rich About used in the window.
            // Keep native editing, window management and standard quit behavior.
            for (index, item) in native_menu.items()?.iter().enumerate() {
                if let Some(submenu) = item.as_submenu() {
                    if (cfg!(target_os = "macos") && index == 0)
                        || (!cfg!(target_os = "macos") && submenu.text()? == "Help")
                    {
                        submenu.remove_at(0)?;
                        submenu.insert(&about, 0)?;
                        submenu.insert(&help, 1)?;
                    }
                }
            }
            app.set_menu(native_menu)?;
            app.on_menu_event(|app, event| {
                let name = match event.id().as_ref() {
                    "about" => "keeper:show-about",
                    "help" => "keeper:show-help",
                    _ => return,
                };
                show(app);
                let _ = app.emit(name, ());
            });
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event({
                    let window = window.clone();
                    move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                });
            }
            println!("CacheKeeper {} ready (Tauri)", updates::VERSION);
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("CacheKeeper startup failed");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<Arc<Runtime>>();
            if !state.exit_allowed.load(Ordering::SeqCst) {
                api.prevent_exit();
                if state.quit_running.swap(true, Ordering::SeqCst) {
                    return;
                }
                let s = state.inner().clone();
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let result = s.bridge.lock().unwrap().stop_all(false, bridge::now());
                    match result {
                        Ok(()) => {
                            s.exit_allowed.store(true, Ordering::SeqCst);
                            app.exit(0);
                        }
                        Err(e) => {
                            *s.last_error.lock().unwrap() = Some(format!("未能停止全部保活：{e}"));
                            s.quit_running.store(false, Ordering::SeqCst);
                            show(&app);
                        }
                    }
                });
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
