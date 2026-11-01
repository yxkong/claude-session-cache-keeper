import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import spawn from 'cross-spawn';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));process.chdir(root);
const pkg=JSON.parse(await fs.readFile('package.json','utf8')),config=JSON.parse(await fs.readFile('release-config.json','utf8'));
const host=process.platform;
const target=process.argv.find(a=>a.startsWith('--target='))?.slice(9)||(host==='darwin'?'universal-apple-darwin':host==='win32'?'x86_64-pc-windows-msvc':'x86_64-unknown-linux-gnu');
const bundles=host==='darwin'?'app':host==='win32'?'nsis':'deb,appimage';
const signed=Boolean(config.tauriUpdaterPublicKey&&process.env.TAURI_SIGNING_PRIVATE_KEY);
await fs.mkdir('.tmp',{recursive:true});
const override={bundle:{createUpdaterArtifacts:signed}};
if(host==='darwin')override.bundle.macOS={signingIdentity:process.env.APPLE_SIGNING_IDENTITY||'-'};
if(host==='darwin')override.app={windows:[{label:'main',title:'CacheKeeper · by yxkong',width:1080,height:820,minWidth:930,minHeight:670,backgroundColor:'#F3FAFA',titleBarStyle:'Overlay',hiddenTitle:true}]};
await fs.writeFile('.tmp/tauri-build.json',JSON.stringify(override));
const flags=[process.env.RUSTFLAGS||'',`--remap-path-prefix=${root}=/source`,`--remap-path-prefix=${os.homedir()}=/build-home`].filter(Boolean).join(' ');
const run=(exe,args,extra={})=>{const r=spawn.sync(exe,args,{cwd:root,stdio:'inherit',env:{...process.env,...extra}});if(r.error||r.status!==0)throw r.error||new Error(`${exe} exited ${r.status}`);};
run(process.execPath,['scripts/notices.mjs',target]);
const cli=path.join(root,'node_modules/.bin/tauri'+(host==='win32'?'.cmd':''));
run(cli,['build','--ci','--target',target,'--bundles',bundles,'--config',path.join(root,'.tmp/tauri-build.json')],{RUSTFLAGS:flags});
const output=path.join(root,'src-tauri/target',target,'release/bundle');
const arch=target.startsWith('universal')?'universal':target.startsWith('aarch64')?'arm64':'x64';
const platform=host==='darwin'?'mac':host==='win32'?'win':'linux';
await fs.mkdir('release/native',{recursive:true});const files=[];
async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory()){if(!e.name.endsWith('.app'))await walk(file);}else{
 const ext=['.app.tar.gz','.AppImage','.dmg','.exe','.msi','.deb','.rpm'].find(x=>e.name.endsWith(x));if(!ext||(host==='darwin'&&ext!=='.app.tar.gz')||(!signed&&ext==='.app.tar.gz'))continue;
 const name=`CacheKeeper-${pkg.version}-${platform}-${arch}${ext}`;await fs.copyFile(file,path.join('release/native',name));
 try{await fs.copyFile(file+'.sig',path.join('release/native',name+'.sig'));}catch(e){if(e.code!=='ENOENT')throw e;}
 files.push({file:name,bytes:(await fs.stat(file)).size});
}}}
await walk(output);
if(host==='darwin'){
 const stage=path.join(root,'.tmp/dmg-stage');await fs.rm(stage,{recursive:true,force:true});await fs.mkdir(stage,{recursive:true});
 await fs.cp(path.join(output,'macos/CacheKeeper.app'),path.join(stage,'CacheKeeper.app'),{recursive:true,verbatimSymlinks:true});await fs.symlink('/Applications',path.join(stage,'Applications'));
 const name=`CacheKeeper-${pkg.version}-mac-${arch}.dmg`;run('hdiutil',['create','-volname','CacheKeeper','-srcfolder',stage,'-format','UDZO','-ov',path.resolve('release/native',name)]);
 files.push({file:name,bytes:(await fs.stat(path.join('release/native',name))).size});
}
if(!files.length)throw new Error('No native installers produced.');
await fs.writeFile(`release/native/build-${platform}.json`,JSON.stringify({version:pkg.version,platform,arch,framework:'tauri',files},null,2)+'\n');
console.log(JSON.stringify({version:pkg.version,platform,arch,files},null,2));
