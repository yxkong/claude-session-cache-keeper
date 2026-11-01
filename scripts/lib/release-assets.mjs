import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { PRODUCT, PLUGIN_FILES, validateBundle, validateCatalog } from '../../app/core/release-contract.mjs';
export async function describe(file) {
  const hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);
  return {file:path.basename(file),bytes:(await fs.stat(file)).size,sha256:hash.digest('hex')};
}
export async function releaseAssets({root,directory}) {
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const plugin=JSON.parse(await fs.readFile(path.join(root,'plugin/.claude-plugin/plugin.json'),'utf8'));
  const config=JSON.parse(await fs.readFile(path.join(root,'release-config.json'),'utf8'));
  await fs.mkdir(directory,{recursive:true});
  const bundle={schema:1,version:plugin.version,bridgeProtocol:config.bridgeProtocol,minAppVersion:config.minimumAppVersion,files:[]};
  for(const name of PLUGIN_FILES){const source=['plugin/LICENSE','plugin/THIRD_PARTY_NOTICES.md'].includes(name)?path.join(root,path.basename(name)):path.join(root,name);bundle.files.push({path:name,data:(await fs.readFile(source)).toString('base64')});}
  validateBundle(bundle);
  const bundleFile=path.join(directory,`CacheKeeper-plugin-${plugin.version}.json`);await fs.writeFile(bundleFile,JSON.stringify(bundle)+'\n');
  const assets=[];
  for(const name of await fs.readdir(directory)){
    if(!name.startsWith(`CacheKeeper-${pkg.version}-`)||!/(?:\.dmg|\.zip|\.exe|\.AppImage|\.tar\.gz)$/.test(name))continue;
    const platform=/(?:-macos-|-mac-)/.test(name)?'darwin':/(?:-windows-|-win-)/.test(name)?'win32':/-linux-/.test(name)?'linux':null;
    // AppImage uses x86_64 in filenames; Node and the update protocol use x64.
    const arch=/-universal\./.test(name)?'universal':/-arm64\./.test(name)?'arm64':/-(?:x64|x86_64)\./.test(name)?'x64':null;
    if(platform&&arch)assets.push({...await describe(path.join(directory,name)),platform,arch});
  }
  for(const p of ['darwin','win32','linux'])if(!assets.some(a=>a.platform===p))throw new Error(`Release is missing ${p} application artifacts.`);
  const catalog=validateCatalog({schema:1,product:PRODUCT,app:{version:pkg.version,assets},plugin:{version:plugin.version,bridgeProtocol:config.bridgeProtocol,minAppVersion:config.minimumAppVersion,...await describe(bundleFile)}});
  await fs.writeFile(path.join(directory,'cachekeeper-update.json'),JSON.stringify(catalog,null,2)+'\n');
  const checksumFiles=(await fs.readdir(directory)).filter(n=>assets.some(a=>a.file===n)||n.startsWith(`CacheKeeper-${pkg.version}-`)||/^latest(?:-mac|-linux)?\.yml$/.test(n)||n===path.basename(bundleFile)||n==='cachekeeper-update.json');
  const lines=[];for(const n of checksumFiles){const file=path.join(directory,n);if((await fs.stat(file)).isFile())lines.push(`${(await describe(file)).sha256}  ${n}`);}
  await fs.writeFile(path.join(directory,'SHA256SUMS.txt'),lines.sort().join('\n')+'\n');return catalog;
}
