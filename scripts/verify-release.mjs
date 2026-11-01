import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const platform=process.platform==='darwin'?'mac':process.platform==='win32'?'win':'linux';
const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
const manifest=JSON.parse(await fs.readFile(`release/native/build-${platform}.json`,'utf8'));
if(manifest.version!==pkg.version||manifest.framework!=='tauri')throw new Error('Build identity mismatch.');
const files=[];
for(const file of manifest.files){const stat=await fs.stat(path.join('release/native',file.file));if(stat.size!==file.bytes)throw new Error('Artifact changed after packaging.');
 const budget=file.file.endsWith('.AppImage')?120:file.file.endsWith('.deb')||file.file.endsWith('.rpm')?30:platform==='mac'?40:30;
 if(stat.size>budget*1024*1024)throw new Error(`${file.file} exceeds ${budget} MiB size budget.`);
 files.push({...file,MiB:Math.round(stat.size/104857.6)/10,budgetMiB:budget});
}
let macApp=null;
if(platform==='mac'){
 const target=manifest.arch==='universal'?'universal-apple-darwin':manifest.arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin';
 const app=path.resolve('src-tauri/target',target,'release/bundle/macos/CacheKeeper.app');
 execFileSync('codesign',['--verify','--deep','--strict',app]);
 const binary=path.join(app,'Contents/MacOS/cachekeeper');const info=execFileSync('lipo',['-info',binary],{encoding:'utf8'});
 if(manifest.arch==='universal'&&(!info.includes('arm64')||!info.includes('x86_64')))throw new Error('Universal application is missing an architecture.');
 const data=await fs.readFile(binary);if(data.includes(Buffer.from(os.homedir())))throw new Error('Local home path embedded in binary.');
 async function inspect(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(['node_modules','node','node.exe','Electron Framework.framework','bridge-contract'].includes(e.name))throw new Error(`Unexpected runtime or test helper: ${e.name}`);if(e.isDirectory())await inspect(path.join(dir,e.name));}}
 await inspect(app);
 for(const name of ['plugin/.claude-plugin/plugin.json','plugin/hooks/register.ts','plugin/hooks/policy.ts']){
  const actual=await fs.readFile(path.join(app,'Contents/Resources/resources/marketplace',name));const expected=await fs.readFile(name);if(!actual.equals(expected))throw new Error(`Bundled connector differs: ${name}`);
 }
 macApp={path:app,signature:'PASS_AD_HOC_OR_BETTER',architectures:info.trim(),runtime:'system WebView'};
}
const report={version:pkg.version,platform,files,macApp,packageChecks:'PASS',targetRuntime:'NOT_RUN',nativeSignedUpgrade:'NOT_RUN',realApiRequests:'NOT_RUN'};
await fs.writeFile(`release/native/verification-${platform}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
