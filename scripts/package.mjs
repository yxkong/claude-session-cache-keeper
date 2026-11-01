import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { packager } from '@electron/packager';
import { ZipArchive } from 'archiver';
import * as tar from 'tar';
import { stageMacApp } from './lib/macos-stage.mjs';
const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const option = process.argv.find(a => a.startsWith('--target='))?.split('=')[1] || 'all';
const macArch = process.argv.find(a => a.startsWith('--mac-arch='))?.split('=')[1] || 'universal';
if (!['universal','x64','arm64'].includes(macArch)) throw new Error('macOS architecture must be universal, x64 or arm64.');
const targets = [
  { key: 'mac', platform: 'darwin', arch: macArch, suffix: `macos-${macArch}` },
  { key: 'windows', platform: 'win32', arch: 'x64', suffix: 'windows-x64' },
  { key: 'linux', platform: 'linux', arch: 'x64', suffix: 'linux-x64' },
].filter(t => option === 'all' || option === t.key);
if (!targets.length) throw new Error('Target must be all, mac, windows or linux.');
if (targets.some(t => t.key === 'mac') && process.platform !== 'darwin') throw new Error('macOS packages must be built on macOS.');
await fs.mkdir(path.join(root, 'release'), { recursive: true });
await fs.mkdir(path.join(root, '.tmp/packager'), { recursive: true });

async function zipDirectory(dir, file) {
  const archive = new ZipArchive({ zlib: { level: 9 } }); const output = createWriteStream(file);
  const complete = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output); archive.directory(dir, path.basename(dir)); await archive.finalize(); await complete;
}
async function one(target) {
  let lastMB = 0;
  console.log(`[${target.suffix}] Packaging Electron ${pkg.devDependencies.electron}`);
  const output = await packager({
    dir: path.join(root, 'build/app'), out: path.join(root, 'build/packages',pkg.version), name: 'CacheKeeper',
    platform: target.platform, arch: target.arch, electronVersion: pkg.devDependencies.electron,
    appVersion: pkg.version, buildVersion: pkg.version, appBundleId: 'io.yxkong.cachekeeper',
    appCategoryType: 'public.app-category.utilities', appCopyright: 'Copyright © 2026 yxkong',
    icon: path.join(root, 'assets/icons/app'), asar: true, prune: false, overwrite: true,
    extraResource: [path.join(root, 'build/resources/marketplace'), path.join(root, 'build/resources/icons'),path.join(root,'build/resources/update-config.json')],
    tmpdir: path.join(root, '.tmp/packager'),
    download: { cacheRoot: path.join(root, '.tmp/electron-cache'), downloadOptions: { quiet: true, getProgressCallback: async p => {
      const mb = Math.floor(p.transferred / 1024 / 1024); if (mb - lastMB >= 40) { lastMB = mb; console.log(`[${target.suffix}] runtime download: ${mb} MiB`); }
    } } },
    ...(target.key === 'mac' ? { osxSign: { identity: '-', identityValidation: false, preAutoEntitlements: false, preEmbedProvisioningProfile: false, gatekeeperAssess: false,
      // osx-sign applies runtime flags per file; a root hardenedRuntime flag is ignored.
      optionsForFile: () => ({ hardenedRuntime:false, entitlements:['com.apple.security.cs.allow-jit'], timestamp:'none' }),
    } } : {}),
    ...(target.key === 'windows' ? { win32metadata: { CompanyName: 'yxkong', FileDescription: 'CacheKeeper — per-session cache keepalive', ProductName: 'CacheKeeper' } } : {}),
  });
  const dir = output[0];
  await fs.copyFile(path.join(root, 'docs/quickstart.md'), path.join(dir, 'QUICKSTART.md'));
  await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(dir, 'THIRD_PARTY_NOTICES.md'));
  const name = `CacheKeeper-${pkg.version}-${target.suffix}`;
  let archive;
  if (target.key === 'mac') {
    archive = path.join(root, 'release', name + '.dmg');
    const stage = path.join(root, 'build', 'dmg-stage-' + target.arch);
    await stageMacApp(path.join(dir,'CacheKeeper.app'),stage);
    await fs.copyFile(path.join(root, 'docs/quickstart.md'), path.join(stage, 'QUICKSTART.md'));
    await fs.symlink('/Applications', path.join(stage, 'Applications')).catch(e => { if (e.code !== 'EEXIST') throw e; });
    console.log(`[${target.suffix}] Creating DMG`);
    await exec('hdiutil', ['create', '-volname', 'CacheKeeper', '-srcfolder', stage, '-ov', '-format', 'UDZO', archive], { maxBuffer: 1024 * 1024 });
  } else if (target.key === 'windows') {
    archive = path.join(root, 'release', name + '.zip'); await zipDirectory(dir, archive);
  } else {
    archive = path.join(root, 'release', name + '.tar.gz');
    await tar.c({ gzip: true, portable: true, cwd: path.dirname(dir), file: archive }, [path.basename(dir)]);
  }
  console.log(`[${target.suffix}] Ready: ${path.basename(archive)}`);
  return { platform: target.platform, arch: target.arch, directory: path.relative(root, dir), archive: path.relative(root, archive), runtime: 'NOT_RUN' };
}
const results = await Promise.allSettled(targets.map(one));
const records = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.status === 'fulfilled') records.push(r.value);
  else { console.error(`[${targets[i].suffix}] Failed:`, r.reason); records.push({ platform: targets[i].platform, arch: targets[i].arch, error: String(r.reason?.message || r.reason), runtime: 'NOT_RUN' }); }
}
await fs.writeFile(path.join(root, 'release/build-results.json'), JSON.stringify({ version: pkg.version, targets: records, nativeInstallersCI: 'NOT_RUN', signedForPublicDistribution: false }, null, 2) + '\n');
if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
