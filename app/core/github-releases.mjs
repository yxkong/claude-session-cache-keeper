import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateCatalog, validateAsset } from './release-contract.mjs';

export class GitHubReleases {
  constructor({ repository, fetch = globalThis.fetch }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('尚未配置有效的 GitHub 更新仓库。');
    this.repository = repository; this.fetch = fetch;
  }
  assetURL(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port || !u.pathname.startsWith(`/${this.repository}/releases/download/`)) throw new Error('更新包来源地址无效。');
    return u.href;
  }
  async request(url, { signal, timeout = 30_000 } = {}) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    for (let i = 0; i < 6; i++) {
      const r = await this.fetch(url, { signal: combined, redirect: 'manual', credentials:'omit', headers: { Accept: 'application/json', 'User-Agent': 'CacheKeeper' } });
      if ([301,302,303,307,308].includes(r.status)) {
        const u = new URL(r.headers.get('location'), url);
        if (u.protocol !== 'https:' || u.username || u.password || u.port || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(u.hostname)) throw new Error('更新包重定向来源无效。');
        await r.body?.cancel(); url = u.href; continue;
      }
      if (r.status === 404) throw new Error('尚未发布公开版本，或更新仓库不存在／不可访问。');
      if ([403,429].includes(r.status)) throw new Error('GitHub 拒绝请求或达到频率限制，请稍后重试。');
      if (!r.ok) throw new Error(`更新请求失败（HTTP ${r.status}）。`);
      return r;
    }
    throw new Error('更新包重定向次数超过限制。');
  }
  async json(url, signal) {
    const r = await this.request(url, { signal }); let total = 0; const chunks = [];
    for await (const chunk of r.body) { total += chunk.length; if (total > 1024 ** 2) { throw new Error('更新清单超过大小限制。'); } chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async latest(signal) {
    const release = await this.json(`https://api.github.com/repos/${this.repository}/releases/latest`, signal);
    if (release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error('更新来源不是正式公开版本。');
    const releaseURL = `https://github.com/${this.repository}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    const manifest = release.assets.find(a => a.name === 'cachekeeper-update.json');
    if (!manifest) throw new Error('该 Release 尚未提供完整的更新清单。');
    const catalog = validateCatalog(await this.json(this.assetURL(manifest.browser_download_url), signal));
    if (release.tag_name !== `v${catalog.app.version}`) throw new Error('Release 标签与更新清单版本不一致。');
    for (const item of [...catalog.app.assets, catalog.plugin]) {
      const a = release.assets.find(a => a.name === item.file);
      if (!a || a.size !== item.bytes) throw new Error('Release 更新包缺失或大小不一致。');
      item.url = this.assetURL(a.browser_download_url);
      if (decodeURIComponent(new URL(item.url).pathname.split('/').at(-1)) !== item.file) throw new Error('更新包来源名称不一致。');
    }
    return { catalog, releaseURL, nativePlatforms:[['darwin','latest-mac.yml'],['win32','latest.yml'],['linux','latest-linux.yml']].filter(([,file])=>release.assets.some(a=>a.name===file)).map(([platform])=>platform), notes: typeof release.body === 'string' ? release.body.slice(0,8000) : '' };
  }
  async download(asset, destination, { signal, onProgress = () => {} } = {}) {
    validateAsset(asset); const url = this.assetURL(asset.url);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temp = destination + '.' + randomUUID() + '.part'; let handle;
    try {
      const response = await this.request(url, { signal, timeout: 20 * 60_000 });
      handle = await fs.open(temp, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > asset.bytes) throw new Error('更新包大小校验失败。');
        hash.update(chunk); await handle.writeFile(chunk); onProgress(Math.floor(bytes / asset.bytes * 100));
      }
      if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('更新包大小或 SHA-256 校验失败。');
      await handle.close(); handle = null; await fs.rename(temp, destination); return destination;
    } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
  }
}
