import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { ZipArchive } from 'archiver';
import * as tar from 'tar';
import { NtExecutable, NtExecutableResource } from 'resedit';
const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const report = JSON.parse(await fs.readFile(path.join(root, 'release/build-results.json'), 'utf8'));
function check(value, message) { if (!value) throw new Error(message); }
async function sha(file) { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); }
const privateMarkers = [/(?:sk-ant-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const localHomes = [...new Set([os.homedir(),process.env.HOME,process.env.USERPROFILE].filter(h => h && h.length > 3).flatMap(h => [h,h.replaceAll('\\','/')]))];
function privateCheck(text,label) {
  for (const home of localHomes) check(!text.toLowerCase().includes(home.toLowerCase()), 'Local home path in '+label);
  for (const pattern of privateMarkers) check(!pattern.test(text), 'Credential pattern in '+label);
}
async function walk(dir) {
  const result = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if(e.name==='bak')continue;
    const file = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...await walk(file)); else if (e.isFile()) result.push(file);
  }
  return result;
}
async function relativeLinks(dir,base = dir) {
  for (const e of await fs.readdir(dir,{withFileTypes:true})) {
    const file = path.join(dir,e.name);
    if (e.isSymbolicLink()) {
      const target = await fs.readlink(file); check(!path.isAbsolute(target),'Absolute app symlink: '+path.relative(base,file));
      const relative = path.relative(base,path.resolve(path.dirname(file),target));
      check(relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative),'App symlink escapes bundle');
    } else if (e.isDirectory()) await relativeLinks(file,base);
  }
}
const sourceRoots = ['app', 'plugin', 'scripts', 'test', 'docs', 'assets', '.claude-plugin', '.github'];
const sourceFiles = ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'INDEX.md', '.gitignore', 'electron-builder.yml', 'electron-builder.config.cjs', 'release-config.json', 'CHANGELOG.md'];
const files = [...sourceFiles.map(f => path.join(root, f)), ...(await Promise.all(sourceRoots.map(d => walk(path.join(root, d))))).flat()]
  .filter(f => !f.includes('/.claude-plugin/types/'));
for (const file of files) {
  if (!/\.(?:mjs|cjs|ts|html|css|json|md|yml|txt|plist|xml)$/.test(file) && !['LICENSE', '.gitignore'].includes(path.basename(file))) continue;
  const text = await fs.readFile(file, 'utf8');
  check(!text.startsWith('\uFEFF'), 'BOM in ' + path.relative(root, file));
  check(!text.includes('\r\n'), 'CRLF in ' + path.relative(root, file));
  privateCheck(text,path.relative(root,file));
}
const sourceZip = path.join(root, `release/CacheKeeper-${pkg.version}-source.zip`);
const zip = new ZipArchive({ zlib: { level: 9 } }); const output = createWriteStream(sourceZip);
const completed = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); zip.on('error', reject); });
zip.pipe(output);
for (const file of files) zip.file(file, { name: `claude-session-cache-keeper-${pkg.version}/` + path.relative(root, file).split(path.sep).join('/') });
await zip.finalize(); await completed;

const platforms = new Set();
const verification = [];
for (const target of report.targets) {
  check(!target.error && target.archive, `${target.platform} build is incomplete`); platforms.add(target.platform);
  const dir = path.join(root, target.directory);
  const resources = path.join(dir, ...(target.platform === 'darwin' ? ['CacheKeeper.app', 'Contents', 'Resources'] : ['resources']));
  const asar = path.join(resources, 'app.asar');
  for (const file of ['main.cjs', 'preload.cjs', 'renderer/renderer.js', 'renderer/index.html', 'renderer/styles.css', 'renderer/logo.png']) {
    const expected = await fs.readFile(path.join(root, 'dist', file));
    check(extractFile(asar, 'dist/' + file).equals(expected), `${target.platform}: packaged source differs: ${file}`);
    if (!file.endsWith('.png')) privateCheck(expected.toString('utf8'),target.platform+': '+file);
  }
  for (const file of ['icon-512.png','tray.png','tray@2x.png','tray-mac.png','tray-mac@2x.png']) check((await fs.readFile(path.join(resources,'icons',file))).equals(await fs.readFile(path.join(root,'assets/icons',file))), `${target.platform}: wrong desktop icon ${file}`);
  check(extractFile(asar,'THIRD_PARTY_NOTICES.md').equals(await fs.readFile(path.join(root,'THIRD_PARTY_NOTICES.md'))), `${target.platform}: stale runtime license notices`);
  const manifest = JSON.parse(await fs.readFile(path.join(resources, 'marketplace/plugin/.claude-plugin/plugin.json'), 'utf8'));
  check(manifest.version === JSON.parse(await fs.readFile(path.join(root,'plugin/.claude-plugin/plugin.json'),'utf8')).version, `${target.platform}: wrong connector version`);
  check((await fs.readFile(path.join(resources,'update-config.json'))).equals(await fs.readFile(path.join(root,'build/resources/update-config.json'))),`${target.platform}: wrong update repository or capability`);
  check(JSON.parse(extractFile(asar,'node_modules/electron-updater/package.json').toString()).version===pkg.dependencies['electron-updater'],`${target.platform}: missing update runtime`);
  for (const file of ['hooks/register.ts','hooks/policy.ts','hooks/hooks.json','.claude-plugin/plugin.json','.claude-plugin/icon.png']) check((await fs.readFile(path.join(resources,'marketplace/plugin',file))).equals(await fs.readFile(path.join(root,'plugin',file))), `${target.platform}: wrong connector resource ${file}`);
  let binary;
  if (target.platform === 'darwin') {
    binary = path.join(dir, 'CacheKeeper.app/Contents/MacOS/CacheKeeper');
    const { stdout } = await exec('lipo', ['-archs', binary]); check(stdout.includes('arm64') && stdout.includes('x86_64'), 'macOS binary is not universal');
    const icon = (await exec('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIconFile',path.join(dir,'CacheKeeper.app/Contents/Info.plist')])).stdout.trim();
    check((await fs.readFile(path.join(resources,icon))).equals(await fs.readFile(path.join(root,'assets/icons/app.icns'))),'macOS bundle icon is not the current brand icon');
    await exec('codesign', ['--verify','--deep','--strict',path.join(dir,'CacheKeeper.app')]);
    const signature = await exec('codesign',['-dvv',path.join(dir,'CacheKeeper.app')]);
    check(!signature.stderr.match(/flags=[^\n]*runtime/),'Local ad-hoc bundle unexpectedly enables hardened runtime');
    await relativeLinks(path.join(dir,'CacheKeeper.app'));
    const staged = path.join(root,'build/dmg-stage-'+target.arch,'CacheKeeper.app');
    await relativeLinks(staged); await exec('codesign',['--verify','--deep','--strict',staged]);
    check(await sha(path.join(staged,'Contents/Resources/app.asar')) === await sha(asar),'DMG staging has stale application code');
    await exec('hdiutil', ['verify',path.join(root,target.archive)]);
  } else if (target.platform === 'win32') {
    binary = path.join(dir, 'CacheKeeper.exe'); const data = await fs.readFile(binary); check(data.subarray(0,2).toString() === 'MZ', 'Windows PE header missing');
    const pe = NtExecutable.from(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength), { ignoreCert:true });
    const resources = NtExecutableResource.from(pe).entries; check(resources.some(e => e.type === 14) && resources.some(e => e.type === 3), 'Windows executable icon resources missing');
    if (process.platform === 'darwin') await exec('unzip', ['-t',path.join(root,target.archive)], { maxBuffer: 2 * 1024 * 1024 });
  } else {
    binary = path.join(dir, 'CacheKeeper'); const data = await fs.readFile(binary); check(data.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])), 'Linux ELF header missing');
    check(data.readUInt16LE(18) === 62, 'Linux ELF is not x86_64'); check((await fs.stat(binary)).mode & 0o111, 'Linux binary is not executable');
    await relativeLinks(dir); let executableInArchive = false;
    await tar.t({ file:path.join(root,target.archive), onentry:e => { if (e.path.endsWith('/CacheKeeper') && e.mode & 0o111) executableInArchive = true; e.resume(); } });
    check(executableInArchive, 'Linux archive lost executable permissions');
  }
  verification.push({ platform:target.platform, arch:target.arch, artifact:path.basename(target.archive), bytes:(await fs.stat(path.join(root,target.archive))).size, sha256:await sha(path.join(root,target.archive)), packageIntegrity:'PASS', runtime:target.runtime || 'NOT_RUN' });
}
check(['darwin','win32','linux'].every(p => platforms.has(p)), 'Three desktop platforms were not all built');
const desktopLog = await fs.readFile(path.join(root,'.tmp/desktop-tests.log'),'utf8').catch(()=> '');
const pluginLog = await fs.readFile(path.join(root,'.tmp/plugin-tests.log'),'utf8').catch(()=> '');
const desktopPass = Number(desktopLog.match(/# pass (\d+)/)?.[1] || 0), desktopFail = Number(desktopLog.match(/# fail (\d+)/)?.[1] || 0);
const pluginPass = Number(pluginLog.match(/\b(\d+) pass\b/)?.[1] || 0), pluginFail = Number(pluginLog.match(/\b(\d+) fail\b/)?.[1] || 0);
check(desktopPass > 0 && desktopFail === 0, 'Desktop regression tests have no passing evidence'); check(pluginPass > 0 && pluginFail === 0, 'Connector regression tests have no passing evidence');
const source = { artifact:path.basename(sourceZip), bytes:(await fs.stat(sourceZip)).size, sha256:await sha(sourceZip) };
let smoke = { startup:'NOT_RUN', visual:'NOT_RUN' }; try { smoke = JSON.parse(await fs.readFile(path.join(root,'.tmp/smoke-evidence.json'),'utf8')); } catch { /* No runtime claim without evidence. */ }
check(smoke.startup !== 'FAIL','Mac startup smoke failed; resolve it before delivery');
if (smoke.packaged && smoke.startup === 'PASS') {
  const mac = verification.find(a => a.platform === 'darwin');
  mac.runtime='STARTUP_ONLY'; mac.startup='PASS'; mac.visual='NOT_RUN';
}
let visual = {status:'NOT_RUN'};
try {
  const evidence = JSON.parse(await fs.readFile(path.join(root,'.tmp/visual-evidence.json'),'utf8'));
  const macDir = report.targets.find(t=>t.platform==='darwin')?.directory;
  if (macDir && evidence.appAsarSha256 === await sha(path.join(root,macDir,'CacheKeeper.app/Contents/Resources/app.asar'))) {
    visual=evidence;
    smoke.visual=evidence.status; smoke.visualReason='Actual packaged app inspected with isolated synthetic sessions.';
    verification.find(a=>a.platform==='darwin').visual=evidence.status;
  }
} catch { /* Never promote stale or missing visual evidence. */ }
let cliSmoke = {status:'NOT_RUN'}; try { const e=JSON.parse(await fs.readFile(path.join(root,'.tmp/cli-v03-evidence.json'),'utf8'));if(e.version===JSON.parse(await fs.readFile(path.join(root,'plugin/.claude-plugin/plugin.json'),'utf8')).version)cliSmoke=e; } catch { /* Optional isolated CLI integration evidence. */ }
const result = { version:pkg.version, checkedAt:new Date().toISOString(), sourcePrivacyPatterns:'PASS', desktopTests:{pass:desktopPass,fail:desktopFail}, connectorTests:{pass:pluginPass,fail:pluginFail}, cliInstallationSmoke:cliSmoke, macOSSmoke:smoke, visualInspection:visual, artifacts:verification, source, nativeInstallersCI:'NOT_RUN', publicSigningAndNotarization:'NOT_RUN', githubPublication:'NOT_RUN' };
await fs.writeFile(path.join(root,'release/verification.json'),JSON.stringify(result,null,2)+'\n');
const updateCatalog=JSON.parse(await fs.readFile(path.join(root,'release/cachekeeper-update.json'),'utf8'));
const updateFiles=[updateCatalog.plugin.file,'cachekeeper-update.json'];
const updateSums=await Promise.all(updateFiles.map(async file=>`${await sha(path.join(root,'release',file))}  ${file}`));
await fs.writeFile(path.join(root,'release/SHA256SUMS.txt'),[...verification,source].map(a => a.sha256+'  '+a.artifact).concat(updateSums).join('\n')+'\n');
console.log(JSON.stringify({version:pkg.version,desktopTests:desktopPass,connectorTests:pluginPass,platforms:[...platforms],packageIntegrity:'PASS',sourcePrivacyPatterns:'PASS'},null,2));
