import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { defaults, limits, validatePolicy } from '../plugin/hooks/policy.ts';
import { PLUGIN_FILES, validateBundle } from '../app/core/release-contract.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const config=JSON.parse(await fs.readFile(path.join(root,'release-config.json'),'utf8'));
const cargo=await fs.readFile(path.join(root,'src-tauri/Cargo.toml'),'utf8');if(cargo.match(/^version = \"([^\"]+)\"/m)?.[1]!==pkg.version)throw new Error('Cargo and package.json application versions differ.');
const dist=path.join(root,'dist/renderer'),resources=path.join(root,'build/resources');
await fs.mkdir(dist,{recursive:true});await fs.mkdir(resources,{recursive:true});
await build({entryPoints:[path.join(root,'app/renderer/tauri-api.mjs'),path.join(root,'app/renderer/renderer.mjs')],outdir:dist,bundle:true,platform:'browser',target:'es2022',format:'iife',sourcemap:false});
for(const name of ['index.html','styles.css'])await fs.copyFile(path.join(root,'app/renderer',name),path.join(dist,name));
await fs.copyFile(path.join(root,'assets/icons/icon-128.png'),path.join(dist,'logo.png'));
let html=await fs.readFile(path.join(dist,'index.html'),'utf8');html=html.replace('<script src="renderer.js"','<script src="tauri-api.js" defer></script>\n  <script src="renderer.js"');await fs.writeFile(path.join(dist,'index.html'),html);
const cases=[];
for(const key of ['minSeconds','maxSeconds','maxAttempts','minCachedTokens'])for(const value of [-1,0,1,29,30,260,280,281,6,99,10000000,10000001,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,1.5]){const policy={...defaults,[key]:value};cases.push({policy,valid:validatePolicy(policy)});}
await fs.writeFile(path.join(resources,'policy-contract.json'),JSON.stringify({defaults,limits,cases,pluginFiles:PLUGIN_FILES},null,2)+'\n');
for(const relative of PLUGIN_FILES){const from=['plugin/LICENSE','plugin/THIRD_PARTY_NOTICES.md'].includes(relative)?path.basename(relative):relative;const dest=path.join(resources,'marketplace',relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,from),dest);}
await fs.mkdir(path.join(resources,'icons'),{recursive:true});
for(const name of ['tray.png','tray-mac.png'])await fs.copyFile(path.join(root,'assets/icons',name),path.join(resources,'icons',name));
await fs.writeFile(path.join(resources,'update-config.json'),JSON.stringify(config,null,2)+'\n');
const manifest=JSON.parse(await fs.readFile(path.join(resources,'marketplace/plugin/.claude-plugin/plugin.json'),'utf8'));
validateBundle({schema:1,version:manifest.version,bridgeProtocol:config.bridgeProtocol,minAppVersion:config.minimumAppVersion,files:await Promise.all(PLUGIN_FILES.map(async name=>({path:name,data:(await fs.readFile(path.join(resources,'marketplace',name))).toString('base64')})))});
console.log(`Built CacheKeeper ${pkg.version} frontend and connector; no Node runtime or node_modules in application resources.`);
