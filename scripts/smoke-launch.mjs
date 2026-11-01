import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));process.chdir(root);await fs.mkdir('.tmp',{recursive:true});
const data=await fs.mkdtemp(path.resolve('.tmp/ui-smoke-'));await fs.mkdir(path.join(data,'sessions'));
const policy={minSeconds:260,maxSeconds:280,maxAttempts:6,minCachedTokens:0};
async function write(){for(const [id,title,busy] of [['demo-a','【演示】接口计费改造',false],['demo-b','【演示】个人工具设计',true]]){
 const c=await fs.readFile(path.join(data,'controls',id+'.json'),'utf8').then(JSON.parse).catch(()=>null);
 await fs.writeFile(path.join(data,'sessions',id+'.json'),JSON.stringify({schema:1,id,sessionId:id,title,project:'/synthetic/project',model:'demo-model',pluginVersion:'0.2.2',bridgeProtocol:1,capabilities:{customAttemptBudget:true},heartbeat:Date.now(),active:true,enabled:c?.enabled??false,busy,inFlight:false,controlRevision:c?.revision??'',policy:c?.policy??policy,attempts:0,nextAt:0,lastCacheAt:0,cacheTokens:0,phase:c?.enabled?(busy?'working':'waiting'):'off',readTokens:0,writeTokens:0,outputTokens:0,lastHit:null}));
}}
await write();const timer=setInterval(()=>write().catch(console.error),1000);
const executable=process.env.CACHE_KEEPER_TEST_EXECUTABLE||path.resolve('src-tauri/target/debug/cachekeeper'+(process.platform==='win32'?'.exe':''));
const child=spawn(executable,[],{env:{...process.env,CACHE_KEEPER_DEMO:'1',CACHE_KEEPER_DATA_DIR:data,CACHE_KEEPER_EXIT_AFTER_READY:process.argv.includes('--exit-after-ready')?'1':'0'},stdio:['ignore','pipe','pipe']});
await fs.writeFile('.tmp/ui-smoke-current.json',JSON.stringify({data,pid:child.pid,executable},null,2)+'\n');child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
const timeout=setTimeout(()=>{console.error('Native WebView startup timed out');child.kill();},30000);
const poll=setInterval(async()=>{if(await fs.stat(path.join(data,'ui-ready.json')).catch(()=>null)){clearTimeout(timeout);clearInterval(poll);}},200);
child.on('error',e=>{clearInterval(timer);clearInterval(poll);clearTimeout(timeout);console.error(e);process.exitCode=1;});
child.on('exit',async(code,signal)=>{clearInterval(timer);clearInterval(poll);clearTimeout(timeout);const ready=await fs.readFile(path.join(data,'ui-ready.json'),'utf8').then(JSON.parse).catch(()=>null);const pass=code===0&&ready?.sessions===2;
 await fs.writeFile('.tmp/smoke-evidence.json',JSON.stringify({startup:pass?'PASS':'FAIL',engine:'Tauri system WebView',ready,exitCode:code,signal,visual:'NOT_RUN',realUserConfigurationChanged:false,realApiRequests:'NOT_RUN'},null,2)+'\n');process.exitCode=pass?0:1;
});
process.on('SIGTERM',()=>child.kill());
