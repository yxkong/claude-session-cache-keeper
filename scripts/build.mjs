import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import spawn from 'cross-spawn';
import { runtimeNotices } from './lib/runtime-notices.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
const releaseConfig=JSON.parse(await fs.readFile(path.join(root,'release-config.json'),'utf8'));
const dist = path.join(root, 'dist');
await fs.mkdir(path.join(dist, 'renderer'), { recursive: true });
await build({ entryPoints: [path.join(root, 'app/main.mjs')], outfile: path.join(dist, 'main.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron','electron-updater'], sourcemap: false });
await fs.copyFile(path.join(root, 'app/preload.cjs'), path.join(dist, 'preload.cjs'));
await build({ entryPoints: [path.join(root, 'app/renderer/renderer.mjs')], outfile: path.join(dist, 'renderer/renderer.js'), bundle: true, platform: 'browser', target: 'es2022', format: 'iife', sourcemap: false });
for (const name of ['index.html', 'styles.css']) await fs.copyFile(path.join(root, 'app/renderer', name), path.join(dist, 'renderer', name));
await fs.copyFile(path.join(root, 'assets/icons/icon-128.png'), path.join(dist, 'renderer/logo.png'));
const appDir = path.join(root, 'build/app');
await fs.mkdir(appDir, { recursive: true });
await fs.cp(dist, path.join(appDir, 'dist'), { recursive: true });
await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description:pkg.description, main: 'dist/main.cjs', author: pkg.author, license: pkg.license, dependencies:pkg.dependencies }, null, 2) + '\n');
// Reproduce the root lock's production graph, including updater's runtime-loaded providers.
const runtime=path.join(root,'build/runtime'),lock=await fs.readFile(path.join(root,'package-lock.json'));
const lockHash=createHash('sha256').update(lock).digest('hex');
if(await fs.readFile(path.join(runtime,'lock.sha256'),'utf8').catch(()=>null)!==lockHash){
  await fs.mkdir(runtime,{recursive:true});await fs.copyFile(path.join(root,'package.json'),path.join(runtime,'package.json'));await fs.writeFile(path.join(runtime,'package-lock.json'),lock);
  const result=spawn.sync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,stdio:'inherit',env:{...process.env,npm_config_cache:path.join(root,'.tmp/npm-cache')}});
  if(result.error||result.status!==0)throw result.error||new Error('Production dependency installation failed.');
  await fs.writeFile(path.join(runtime,'lock.sha256'),lockHash);
}
await fs.rm(path.join(appDir,'node_modules'),{recursive:true,force:true});
await fs.cp(path.join(runtime,'node_modules'),path.join(appDir,'node_modules'),{recursive:true,verbatimSymlinks:true});
await runtimeNotices(root,runtime);
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(root, name), path.join(appDir, name));
const market = path.join(root, 'build/resources/marketplace');
for (const name of ['.claude-plugin/plugin.json', '.claude-plugin/icon.png', 'hooks/register.ts', 'hooks/policy.ts', 'hooks/hooks.json']) {
  await fs.mkdir(path.dirname(path.join(market, 'plugin', name)), { recursive: true });
  await fs.copyFile(path.join(root, 'plugin', name), path.join(market, 'plugin', name));
}
await fs.mkdir(path.join(market, '.claude-plugin'), { recursive: true });
await fs.copyFile(path.join(root, '.claude-plugin/marketplace.json'), path.join(market, '.claude-plugin/marketplace.json'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(root, name), path.join(market, 'plugin', name));
await fs.mkdir(path.join(root, 'build/resources/icons'), { recursive: true });
await fs.writeFile(path.join(root,'build/resources/update-config.json'),JSON.stringify({...releaseConfig,nativeUpdates:process.env.CACHE_KEEPER_NATIVE_UPDATES==='1'},null,2)+'\n');
for (const name of ['icon-512.png', 'tray.png', 'tray@2x.png', 'tray-mac.png', 'tray-mac@2x.png']) await fs.copyFile(path.join(root, 'assets/icons', name), path.join(root, 'build/resources/icons', name));
console.log(`Built CacheKeeper ${pkg.version} app and executor resources.`);
