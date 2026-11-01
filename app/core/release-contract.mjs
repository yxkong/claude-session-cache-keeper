import semver from 'semver';
export const PRODUCT = 'io.yxkong.cachekeeper';
export const PLUGIN_FILES = Object.freeze(['plugin/.claude-plugin/plugin.json','plugin/.claude-plugin/icon.png','plugin/hooks/hooks.json','plugin/hooks/register.ts','plugin/hooks/policy.ts','plugin/LICENSE','plugin/THIRD_PARTY_NOTICES.md','.claude-plugin/marketplace.json']);
export const stableVersion = v => typeof v === 'string' && semver.valid(v) === v && !semver.prerelease(v);
export function validateAsset(a, limit = 1024 ** 3) {
  if (!a || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(a.file || '') || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > limit || !/^[a-f0-9]{64}$/.test(a.sha256 || '')) throw new Error('更新包地址、大小或校验值无效。');
  return a;
}
export function validateCatalog(m) {
  if (m?.schema !== 1 || m.product !== PRODUCT || !stableVersion(m.app?.version) || !Array.isArray(m.app.assets) || m.app.assets.length > 30 || !stableVersion(m.plugin?.version) || !stableVersion(m.plugin.minAppVersion) || m.plugin.bridgeProtocol !== 1) throw new Error('更新清单版本或桥接协议不兼容。');
  validateAsset(m.plugin, 3 * 1024 ** 2);
  if (m.plugin.file !== `CacheKeeper-plugin-${m.plugin.version}.json`) throw new Error('插件更新包名称无效。');
  const names = new Set([m.plugin.file]);
  for (const a of m.app.assets) {
    validateAsset(a);
    if (!['darwin','win32','linux'].includes(a.platform) || !['x64','arm64','universal'].includes(a.arch) || !a.file.startsWith(`CacheKeeper-${m.app.version}-`) || names.has(a.file)) throw new Error('应用更新包平台或名称无效。');
    names.add(a.file);
  }
  return m;
}
export function validateBundle(b, expected) {
  if (b?.schema !== 1 || !stableVersion(b.version) || b.bridgeProtocol !== 1 || !stableVersion(b.minAppVersion) || !Array.isArray(b.files) || b.files.length !== PLUGIN_FILES.length || (expected && (b.version !== expected.version || b.bridgeProtocol !== expected.bridgeProtocol || b.minAppVersion !== expected.minAppVersion))) throw new Error('插件包版本或兼容性校验失败。');
  const files = new Map(); let bytes = 0;
  for (const f of b.files) {
    if (!PLUGIN_FILES.includes(f.path) || files.has(f.path) || typeof f.data !== 'string' || f.data.length > 4 * 1024 ** 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) throw new Error('插件包文件路径或内容无效。');
    const data = Buffer.from(f.data, 'base64'); bytes += data.length;
    if (bytes > 2 * 1024 ** 2) throw new Error('插件包超过大小限制。');
    files.set(f.path, data);
  }
  const plugin = JSON.parse(files.get('plugin/.claude-plugin/plugin.json').toString('utf8'));
  const marketplace = JSON.parse(files.get('.claude-plugin/marketplace.json').toString('utf8'));
  if (plugin.name !== 'session-cache-keeper' || plugin.version !== b.version || marketplace.name !== 'yxkong-cache-tools' || marketplace.plugins?.length !== 1 || marketplace.plugins[0].name !== plugin.name || marketplace.plugins[0].source !== './plugin') throw new Error('插件包身份校验失败。');
  const advertised=files.get('plugin/hooks/register.ts').toString('utf8').match(/\bpluginVersion:\s*(['"])([^'"]+)\1/);
  if(advertised?.[2]!==b.version)throw new Error('插件报告的版本与发布版本不一致。');
  return files;
}
