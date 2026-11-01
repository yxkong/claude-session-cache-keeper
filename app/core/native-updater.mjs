// Keep this dependency external when bundling: its providers use runtime require().
import updater from 'electron-updater';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
export class NativeUpdater {
  constructor({ autoUpdater = updater.autoUpdater, prepareQuit = () => {}, recoverQuit = () => {} }) {
    this.updater = autoUpdater; this.prepareQuit = prepareQuit; this.recoverQuit=recoverQuit;
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false; autoUpdater.allowDowngrade = false;
    // EventEmitter errors must be handled even outside a user-triggered download.
    autoUpdater.on('error',error=>{if(this.installError){const reject=this.installError;this.installError=null;this.recoverQuit();reject(error);}});
  }
  async download(version,onProgress,expected) {
    const result = await this.updater.checkForUpdates();
    if (!result || result.updateInfo.version !== version) throw new Error('发布版本已变化，请重新检查更新。');
    this.cancellation = result.cancellationToken;
    const progress = p => onProgress(Math.max(0,Math.min(100,Math.round(p.percent))));
    this.updater.on('download-progress',progress);
    try {
      this.ready=false;
      const files=await this.updater.downloadUpdate(this.cancellation);
      const file=files.find(f=>f.endsWith(expected.file.slice(expected.file.lastIndexOf('.'))));
      if(!file || (await fs.stat(file)).size!==expected.bytes)throw new Error('应用下载大小校验失败。');
      const hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);
      if(hash.digest('hex')!==expected.sha256)throw new Error('应用下载 SHA-256 校验失败。');
      this.ready = true;
    }
    finally { this.updater.removeListener('download-progress',progress); this.cancellation = null; }
  }
  cancel() { this.cancellation?.cancel(); }
  async install() {
    if (!this.ready) throw new Error('更新尚未下载完成。');
    return new Promise((_resolve,reject)=>{
      this.installError=reject;
      try{this.prepareQuit();this.updater.quitAndInstall(false,true);}
      catch(e){this.installError=null;this.recoverQuit();reject(e);}
    });
  }
}
