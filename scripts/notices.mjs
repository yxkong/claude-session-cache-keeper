import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const target=process.argv[2]||({darwin:'aarch64-apple-darwin',win32:'x86_64-pc-windows-msvc',linux:'x86_64-unknown-linux-gnu'}[process.platform]);
const targets=target==='universal-apple-darwin'?['aarch64-apple-darwin','x86_64-apple-darwin']:[target];
const active=new Set(),packages=new Map();
for(const target of targets){const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1','--manifest-path','src-tauri/Cargo.toml','--filter-platform',target],{encoding:'utf8',maxBuffer:16*1024*1024}));const nodes=new Map(metadata.resolve.nodes.map(n=>[n.id,n]));
const visited=new Set();const visit=id=>{if(visited.has(id))return;visited.add(id);active.add(id);for(const edge of nodes.get(id)?.deps||[])if(edge.dep_kinds.some(k=>k.kind===null))visit(edge.pkg);};visit(metadata.resolve.root);for(const p of metadata.packages)packages.set(p.id,p);}
const out='build/resources/licenses';await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});const inventory=[];
for(const p of packages.values()){if(!p.source||!active.has(p.id))continue;const dir=path.dirname(p.manifest_path),files=[];
 for(const n of await fs.readdir(dir)){if(!/^(?:LICENSE|LICENCE|COPYING)(?:$|[.-])/i.test(n))continue;const file=path.join(dir,n);if(!(await fs.stat(file)).isFile())continue;const dest=`${p.name}-${p.version}-${n}`;await fs.copyFile(file,path.join(out,dest));files.push(dest);}
 if(p.license_file&&!files.length){const file=path.resolve(dir,p.license_file),dest=`${p.name}-${p.version}-LICENSE`;await fs.copyFile(file,path.join(out,dest));files.push(dest);}
 if(!p.license&&!files.length)throw new Error(`Missing license metadata: ${p.name} ${p.version}`);
 inventory.push({name:p.name,version:p.version,license:p.license,files});
}
for(const name of ['semver','@tauri-apps/api']){const dir=path.join('node_modules',name);for(const file of await fs.readdir(dir)){if(/^LICENSE(?:$|[._-])/i.test(file))await fs.copyFile(path.join(dir,file),path.join(out,name.replaceAll('/','-')+'-'+file));}}
await fs.writeFile(path.join(out,'inventory.json'),JSON.stringify(inventory,null,2)+'\n');
for(const n of ['LICENSE','THIRD_PARTY_NOTICES.md'])await fs.copyFile(n,path.join(out,n));
console.log(`Collected license metadata for ${inventory.length} locked Rust packages and semver.`);
