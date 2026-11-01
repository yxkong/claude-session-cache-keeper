import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { randomUUID } from 'node:crypto';
import { validateBundle, validateCatalog } from './release-contract.mjs';

export class UpdateManager {
  constructor({ version, pluginVersion, source, installer, repository, dataRoot, platform, arch, native = null, demo = false }) {
    Object.assign(this, { version, pluginVersion, source, installer, repository, dataRoot, platform, arch, native, demo });
    this.value = { phase:'idle', repository:source.repository, app:{ current:version }, plugin:{ bundled:pluginVersion }, progress:null, message:'按需检查，下载后由你决定何时安装。' };
  }
  snapshot() { return structuredClone(this.value); }
  async idle() {
    const rows = await this.repository.refresh();
    if (rows.some(s => s.online && (s.enabled || s.busy !== false || s.inFlight !== false))) throw new Error('请等待 Claude 任务完成，并停止相关会话的保活后再安装更新。');
  }
  async check() {
    if (this.running) throw new Error('正在处理更新，请稍候。');
    this.running = true; this.value.phase = 'checking'; this.value.message = '正在检查 GitHub Release…';
    try {
      const result = await this.source.latest(); const m = validateCatalog(result.catalog);
      let installed = null, inspectionError=''; try { installed = await this.installer.installed(); } catch(e) { inspectionError=e.message; }
      const installedVersion=semver.valid(installed?.version)?installed.version:null;
      const currentPlugin = installedVersion || this.pluginVersion;
      this.useNative=Boolean(this.native && result.nativePlatforms?.includes(this.platform));
      const assets = m.app.assets.filter(a => a.platform === this.platform && [this.arch,'universal'].includes(a.arch));
      const suffixes = this.platform === 'darwin' ? (this.useNative ? ['.zip','.dmg'] : ['.dmg','.zip']) : this.platform === 'win32' ? ['.exe','.zip'] : ['.AppImage','.tar.gz'];
      this.appAsset = suffixes.map(ext => assets.find(a => a.file.endsWith(ext))).find(Boolean);
      this.catalog = m;
      this.pluginStage=null;this.appDownload=null;
      this.value = { phase:'checked', repository:this.source.repository, releaseURL:result.releaseURL, notes:result.notes || '', checkedAt:Date.now(), progress:null,
        app:{ current:this.version, latest:m.app.version, available:semver.gt(m.app.version,this.version), downloadable:Boolean(this.appAsset), native:this.useNative, ready:false },
        plugin:{ current:installedVersion, inspectionError, bundled:this.pluginVersion, latest:m.plugin.version, available:semver.gt(m.plugin.version,currentPlugin), compatible:semver.gte(this.version,m.plugin.minAppVersion), minimumApp:m.plugin.minAppVersion, ready:false },
        message:'检查完成。插件安装后，目标会话仍需重载；正在运行的模块保持原版本。' };
      return this.snapshot();
    } catch (e) { this.value.phase = 'error'; this.value.message = e.message; throw e; }
    finally { this.running = false; }
  }
  async perform(operation, fn) {
    if (this.demo) throw new Error('演示模式不会下载或安装真实更新。');
    if (this.running) throw new Error('正在处理更新，请稍候。');
    this.running = true; this.value.phase = operation; this.value.progress = 0;
    this.abort = new AbortController();
    try { return await fn(); }
    catch (e) { this.value.phase = 'error'; this.value.message = this.abort.signal.aborted ? '已取消下载，原版本保持可用。' : e.message; throw e; }
    finally { this.running = false; this.abort = null; this.value.progress = null; }
  }
  cancel() { this.abort?.abort(); this.native?.cancel(); }
  async downloadPlugin() {
    if (!this.value.plugin.available || !this.value.plugin.compatible) throw new Error('插件不可更新，请先检查应用版本与兼容性。');
    return this.perform('downloading-plugin', async () => {
      const p = this.catalog.plugin; const dir = path.join(this.dataRoot,'updates',randomUUID());
      const file = path.join(dir,p.file);
      await this.source.download(p,file,{ signal:this.abort.signal,onProgress:p=>{this.value.progress=p;} });
      const files = validateBundle(JSON.parse(await fs.readFile(file,'utf8')),p);
      const stage = path.join(dir,'marketplace');
      for (const [name,data] of files) { const target = path.join(stage,name); await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700}); await fs.writeFile(target,data,{mode:0o600}); }
      this.pluginStage = stage; this.value.plugin.ready = true; this.value.phase = 'downloaded'; this.value.message = '插件包已校验。待任务完成、停止保活后，可安装更新。';
      return this.snapshot();
    });
  }
  async applyPlugin() {
    if (!this.value.plugin.compatible) throw new Error('插件要求更高的应用版本，请先更新应用以满足兼容性。');
    await this.idle();
    if (!this.value.plugin.ready || !this.pluginStage) throw new Error('请先下载并校验插件更新。');
    return this.perform('installing-plugin',async()=>{
      await this.idle(); await this.installer.install({ resources:this.pluginStage });
      this.value.plugin.current = this.catalog.plugin.version; this.value.plugin.available = false; this.value.plugin.ready = false;
      this.value.phase = 'installed'; this.value.message = '插件已安装。请在目标 Claude 会话手动重载；若仍为旧版，待任务结束后重启 Claude。新连接默认关闭。';
      return this.snapshot();
    });
  }
  async downloadApp() {
    if (!this.value.app.available || !this.appAsset) throw new Error('没有当前系统的可用更新包，请查看发布页。');
    return this.perform('downloading-app',async()=>{
      if (this.useNative) {
        await this.native.download(this.catalog.app.version, p=>{this.value.progress=p;}, this.appAsset);
        this.appDownload = null;
      } else {
        this.appDownload = await this.source.download(this.appAsset,path.join(this.dataRoot,'updates',this.appAsset.file),{ signal:this.abort.signal,onProgress:p=>{this.value.progress=p;} });
      }
      this.value.app.ready = true; this.value.phase = 'downloaded'; this.value.message = this.useNative ? '应用更新已下载。待任务完成、停止保活后，可重启应用完成安装。' : '安装包已校验。此构建需手动安装，可打开下载目录替换应用。';
      return this.snapshot();
    });
  }
  async applyApp() {
    if (this.demo) throw new Error('演示模式不会安装真实更新。');
    if (!this.value.app.ready) throw new Error('请先下载应用更新。');
    if (!this.useNative) { try { await fs.access(this.appDownload); } catch { this.value.app.ready=false;throw new Error('下载文件已移除，请重新下载。'); } return this.appDownload; }
    return this.perform('installing-app',async()=>{await this.idle();await this.repository.stopAll();await this.native.install();return null;});
  }
}
