import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { releaseAssets } from '../scripts/lib/release-assets.mjs';
import { GitHubReleases } from '../app/core/github-releases.mjs';
import { UpdateManager } from '../app/core/updates.mjs';
import { PluginInstaller } from '../app/core/cli.mjs';
test('published-format HTTP fixture downloads, verifies, and installs only the plugin without enabling sessions',async t=>{
  const root=await fs.mkdtemp(path.resolve('.tmp/release-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'release');await fs.mkdir(directory);
  const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
  for(const name of ['macos-universal.dmg','windows-x64.zip','linux-x64.tar.gz'])await fs.writeFile(path.join(directory,`CacheKeeper-${pkg.version}-${name}`),'synthetic installer');
  const catalog=await releaseAssets({root:process.cwd(),directory});
  const repository='synthetic-owner/cachekeeper',tag=`v${pkg.version}`;
  const names=(await fs.readdir(directory));
  const assets=await Promise.all(names.map(async name=>({name,size:(await fs.stat(path.join(directory,name))).size,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${name}`})));
  const server=http.createServer(async(req,res)=>{
    if(req.url.endsWith('/releases/latest'))res.end(JSON.stringify({tag_name:tag,draft:false,prerelease:false,assets,body:'synthetic release notes'}));
    else {const name=decodeURIComponent(req.url.split('/').at(-1));if(!names.includes(name)){res.writeHead(404);res.end();}else res.end(await fs.readFile(path.join(directory,name)));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const source=new GitHubReleases({repository,fetch:(url,options)=>fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,options)});
  const dataRoot=path.join(root,'user-data');let installedVersion='0.2.0',working=false,mutations=0;
  const installer=new PluginInstaller({resources:'unused',dataRoot,repository:{stopAll:async()=>{throw new Error('Plugin-only update must not stop unrelated sessions');}},cli:'synthetic-cli',run:async(_exe,args)=>{
    if(args[1]==='list')return JSON.stringify([{id:'session-cache-keeper@yxkong-cache-tools',version:installedVersion,enabled:true}]);
    mutations++;installedVersion=JSON.parse(await fs.readFile(path.join(dataRoot,'marketplace/plugin/.claude-plugin/plugin.json'),'utf8')).version;return '{"outcome":"ok"}';
  }});
  const manager=new UpdateManager({version:pkg.version,pluginVersion:'0.2.0',source,installer,repository:{refresh:async()=>[{online:true,enabled:false,busy:working,inFlight:false}]},dataRoot,platform:'darwin',arch:'arm64'});
  await manager.check();assert.equal(manager.snapshot().app.available,false);assert.equal(manager.snapshot().plugin.available,true);
  await manager.downloadPlugin();assert.equal(mutations,0);await assert.rejects(fs.access(path.join(dataRoot,'controls')));
  working=true;await assert.rejects(manager.applyPlugin(),/任务|保活/);assert.equal(mutations,0);
  working=false;await manager.applyPlugin();assert.equal(installedVersion,catalog.plugin.version);assert.equal(manager.snapshot().plugin.current,installedVersion);
  assert.equal(await fs.readFile(path.join(dataRoot,'marketplace/plugin/hooks/register.ts'),'utf8'),await fs.readFile('plugin/hooks/register.ts','utf8'));
  await assert.rejects(fs.access(path.join(dataRoot,'controls')));
  await manager.check();await assert.rejects(manager.applyPlugin(),/先下载/);
  const manual=new UpdateManager({version:'0.2.9',pluginVersion:'0.2.0',source,installer,repository:{refresh:async()=>[]},dataRoot:path.join(root,'manual'),platform:'darwin',arch:'arm64'});
  await manual.check();await manual.downloadApp();const downloaded=await manual.applyApp();assert.equal(await fs.readFile(downloaded,'utf8'),'synthetic installer');
});
