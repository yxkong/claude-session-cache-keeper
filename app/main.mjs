import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, shell, dialog, session, net } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeRepository } from './core/bridge.mjs';
import { rootsFor } from './core/platform.mjs';
import { PluginInstaller } from './core/cli.mjs';
import { EXECUTOR_VERSION } from './core/contracts.mjs';
import { GitHubReleases } from './core/github-releases.mjs';
import { UpdateManager } from './core/updates.mjs';
import { NativeUpdater } from './core/native-updater.mjs';

const roots = rootsFor();
const demo = process.env.CACHE_KEEPER_DEMO === '1';
if (demo && !process.env.CACHE_KEEPER_DATA_DIR) throw new Error('演示模式必须指定隔离的数据目录。');
fs.mkdirSync(path.join(roots[0], 'app-data'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(roots[0], 'app-data'));
app.setName('CacheKeeper');
const single = app.requestSingleInstanceLock();
if (!single) app.exit(0);
let window, tray, quitting = false, exitReady = false;
const repository = new BridgeRepository({ roots });
const resourceRoot = () => app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build/resources');
const rendererFile = () => path.join(app.getAppPath(), 'dist/renderer/index.html');
let installer, updates;

function show() { window?.show(); window?.focus(); }
function trusted(event) {
  if (!window || event.sender !== window.webContents || !event.senderFrame?.url.startsWith('file:')) throw new Error('不可信的应用请求。');
  if (path.resolve(fileURLToPath(event.senderFrame.url)) !== path.resolve(rendererFile())) throw new Error('请求不来自应用页面。');
}
function handle(name, fn) { ipcMain.handle(name, async (event, payload) => { trusted(event); return fn(payload); }); }
async function state() {
  try { return { sessions: await repository.refresh(), warnings: repository.warnings, version: app.getVersion(), executorVersion: EXECUTOR_VERSION, platform: process.platform, arch: process.arch, demo, updates:updates?.snapshot() }; }
  catch (e) { return { sessions: [], warnings: [e.message], version: app.getVersion(), executorVersion: EXECUTOR_VERSION, platform: process.platform, arch: process.arch, demo }; }
}

app.on('second-instance', show);
app.on('activate', show);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (exitReady) { tray?.destroy(); return; }
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  repository.stopAll().then(() => { exitReady = true; tray?.destroy(); app.quit(); }).catch(e => {
    quitting = false; show(); dialog.showErrorBox('未能停止全部保活', e.message + '\n应用暂未退出，请在相关 Claude 会话中停止保活。');
  });
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  installer = new PluginInstaller({ resources: path.join(resourceRoot(), 'marketplace'), dataRoot: roots[0], repository });
  const updateConfig = JSON.parse(fs.readFileSync(path.join(resourceRoot(),'update-config.json'),'utf8'));
  const native = !demo && app.isPackaged && updateConfig.nativeUpdates === true && (process.platform !== 'linux' || process.env.APPIMAGE)
    ? new NativeUpdater({ prepareQuit:()=>{exitReady=true;},recoverQuit:()=>{exitReady=false;} }) : null;
  updates = new UpdateManager({ version:app.getVersion(),pluginVersion:EXECUTOR_VERSION,source:new GitHubReleases({repository:updateConfig.repository,fetch:(url,options)=>net.fetch(url,options)}),installer,repository,dataRoot:roots[0],platform:process.platform,arch:process.arch,native,demo });
  handle('keeper:state', state);
  handle('keeper:save', async payload => { if ((installer.busy || updates.snapshot().phase==='installing-app') && payload?.control?.enabled) throw new Error('正在安装更新，请稍后再开启保活。'); await repository.refresh(); await repository.save(payload?.id, payload?.control); return state(); });
  handle('keeper:install', async () => { if (demo) throw new Error('演示模式不安装真实插件。'); await updates.idle(); return installer.install(); });
  handle('keeper:update', async action => {
    switch(action) {
      case 'check': return updates.check();
      case 'download-app': return updates.downloadApp();
      case 'download-plugin': return updates.downloadPlugin();
      case 'apply-plugin': return updates.applyPlugin();
      case 'cancel': updates.cancel(); return updates.snapshot();
      case 'apply-app': { const file=await updates.applyApp(); if(file) shell.showItemInFolder(file); return updates.snapshot(); }
      case 'release': await shell.openExternal(`https://github.com/${updateConfig.repository}/releases`); return updates.snapshot();
      default: throw new Error('无效的更新操作。');
    }
  });
  handle('keeper:stop-all', async () => { await repository.stopAll(); return state(); });
  handle('keeper:copy-reload', () => { clipboard.writeText('/reload-plugins'); return true; });
  handle('keeper:docs', () => shell.openExternal('https://code.claude.com/docs/en/setup'));
  window = new BrowserWindow({
    width: 1080, height: 820, minWidth: 930, minHeight: 670,
    title: 'CacheKeeper · by yxkong', backgroundColor: '#F3FAFA',
    icon: path.join(resourceRoot(), 'icons/icon-512.png'),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { preload: path.join(app.getAppPath(), 'dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  window.on('close', event => { if (!exitReady) { event.preventDefault(); window.hide(); } });
  const trayImage = nativeImage.createFromPath(path.join(resourceRoot(),'icons',process.platform === 'darwin'?'tray-mac.png':'tray.png'));
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  if (demo) console.log('CacheKeeper tray: '+JSON.stringify({...trayImage.getSize(),template:Boolean(trayImage.isTemplateImage?.())}));
  tray.setToolTip('CacheKeeper · 会话缓存保活');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开会话列表', click: show },
    { label: '检查更新…', click:()=>{show();window.webContents.send('keeper:show-updates');} },
    { label: '停止全部保活', click: () => repository.stopAll().catch(e => dialog.showErrorBox('停止失败', e.message)) },
    { type: 'separator' }, { label: '停止全部并退出', click: () => app.quit() },
  ]));
  tray.on('double-click', show);
  const menu = [{ label: 'CacheKeeper', submenu: [{ label: '会话列表', click: show }, { label:'检查更新…',click:()=>{show();window.webContents.send('keeper:show-updates');} }, { label: '停止全部并退出', click: () => app.quit() }] }, { role: 'editMenu' }, { role: 'windowMenu' }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  await window.loadFile(rendererFile());
  console.log('CacheKeeper ready');
});
process.on('SIGTERM', () => app.quit());
