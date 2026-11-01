import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GitHubReleases } from '../app/core/github-releases.mjs';
import { UpdateManager } from '../app/core/updates.mjs';
import { validateBundle, validateCatalog } from '../app/core/release-contract.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const repo='synthetic-owner/cachekeeper';
const asset=(file,data,extra={})=>({file,bytes:data.length,sha256:digest(data),...extra});
const manifest=()=>({schema:1,product:'io.yxkong.cachekeeper',app:{version:'0.4.0',assets:[]},plugin:{version:'0.2.2',bridgeProtocol:1,minAppVersion:'0.3.0',...asset('CacheKeeper-plugin-0.2.2.json',Buffer.from('synthetic'))}});

test('release contract rejects incompatible protocols, path injection, and malformed hashes',()=>{
  assert.equal(validateCatalog(manifest()).plugin.version,'0.2.2');
  for(const patch of [{bridgeProtocol:2},{file:'../plugin.json'},{sha256:'unverified'},{minAppVersion:'latest'}]){
    const m=manifest();Object.assign(m.plugin,patch);assert.throws(()=>validateCatalog(m));
  }
  assert.throws(()=>validateBundle({schema:1,version:'0.2.2',files:[{path:'../../settings.json',data:'e30='}]}));
});
test('GitHub source distinguishes no release from up-to-date and refuses foreign asset URLs',async()=>{
  const absent=new GitHubReleases({repository:repo,fetch:async()=>new Response('',{status:404})});
  await assert.rejects(absent.latest(),/未发布|不存在|不可访问/);
  const foreign=new GitHubReleases({repository:repo,fetch:async()=>new Response(JSON.stringify({tag_name:'v0.4.0',draft:false,prerelease:false,html_url:'https://github.com/'+repo+'/releases/tag/v0.4.0',assets:[{name:'cachekeeper-update.json',browser_download_url:'https://evil.invalid/feed'}]}))});
  await assert.rejects(foreign.latest(),/来源|地址/);
});
test('a corrupted download never replaces a previous verified file',async t=>{
  const root=await fs.mkdtemp(path.resolve('.tmp/update-download-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const target=path.join(root,'plugin.json');await fs.writeFile(target,'previous');
  const source=new GitHubReleases({repository:repo,fetch:async()=>new Response('corrupt')});
  const item={...asset('plugin.json',Buffer.from('expected')),url:'https://github.com/'+repo+'/releases/download/v0.4.0/plugin.json'};
  await assert.rejects(source.download(item,target),/校验|大小/);assert.equal(await fs.readFile(target,'utf8'),'previous');
});
test('checking and downloading never installs; working sessions block applying plugin updates',async t=>{
  const root=await fs.mkdtemp(path.resolve('.tmp/update-manager-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let writes=0;let rows=[{online:true,enabled:false,busy:true,inFlight:false}];
  const source={repository:repo,latest:async()=>({catalog:manifest(),releaseURL:'https://github.com/'+repo+'/releases/tag/v0.4.0'}),download:async(_a,dest)=>{await fs.writeFile(dest,'download');return dest;}};
  const installer={installed:async()=>({version:'0.2.1'}),install:async()=>{writes++;}};
  const manager=new UpdateManager({version:'0.3.0',pluginVersion:'0.2.1',source,installer,repository:{refresh:async()=>rows},dataRoot:root,platform:'darwin',arch:'arm64'});
  await manager.check();assert.equal(manager.snapshot().plugin.available,true);assert.equal(writes,0);
  await assert.rejects(manager.applyPlugin(),/任务|保活/);assert.equal(writes,0);
  rows=[{online:true,enabled:true,busy:false,inFlight:false}];await assert.rejects(manager.applyPlugin(),/任务|保活/);assert.equal(writes,0);
});
test('an old app cannot install a newer plugin requiring a higher minimum version',async t=>{
  const root=await fs.mkdtemp(path.resolve('.tmp/update-incompatible-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const m=manifest();m.plugin.minAppVersion='0.5.0';let installs=0;
  const manager=new UpdateManager({version:'0.3.0',pluginVersion:'0.2.1',source:{repository:repo,latest:async()=>({catalog:m,releaseURL:'https://github.com/'+repo+'/releases/tag/v0.4.0'})},installer:{installed:async()=>({version:'0.2.1'}),install:async()=>{installs++;}},repository:{refresh:async()=>[]},dataRoot:root,platform:'darwin',arch:'arm64'});
  await manager.check();assert.equal(manager.snapshot().plugin.compatible,false);await assert.rejects(manager.applyPlugin(),/应用版本|兼容/);assert.equal(installs,0);
});
