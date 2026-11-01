import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = await fs.mkdtemp(path.join(root, '.tmp/ui-smoke-'));
await fs.mkdir(path.join(data, 'sessions'), { recursive: true });
await fs.mkdir(path.join(data, 'claude-config/projects/synthetic'), { recursive: true });
const policy = { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0 };
const examples = [
  { id: 'demo-a', sessionId: 'DEMO-A', title: '【演示】接口计费改造', project: '/synthetic/api-project', model: 'demo-model', pluginVersion: '0.2.1', bridgeProtocol:1,capabilities:{customAttemptBudget:true} },
  { id: 'demo-b', sessionId: 'DEMO-B', title: '【演示】个人工具设计', project: '/synthetic/tool-project', model: 'demo-model', pluginVersion: '0.2.1', bridgeProtocol:1,capabilities:{customAttemptBudget:true} },
  { id: 'demo-legacy', sessionId: 'DEMO-LEGACY', title: '【演示】旧版连接', project: '/synthetic/legacy-project', model: 'demo-model', pluginVersion: '0.1.2' },
];
async function write() {
  const heartbeat = Date.now();
  for (const row of examples) {
    // Acknowledge only synthetic controls. This fixture never loads a model or sends API calls.
    const c = await fs.readFile(path.join(data,'controls',row.id+'.json'),'utf8').then(JSON.parse).catch(()=>null);
    const enabled = c?.id === row.id && c.enabled === true;
    await fs.writeFile(path.join(data, 'sessions', row.id + '.json'), JSON.stringify({ schema: 1, ...row, heartbeat, active: true, enabled, busy:row.id==='demo-b',inFlight:false,controlRevision: c?.revision || '', policy:c?.policy || policy, attempts: 0, nextAt: 0, lastCacheAt: 0, cacheTokens: 0, phase: enabled?'waiting':'off', readTokens: 0, writeTokens: 0, outputTokens: 0, lastHit: null }));
  }
}
await write(); const timer = setInterval(write, 2000);
const env = { ...process.env, CACHE_KEEPER_DATA_DIR: data, CLAUDE_CONFIG_DIR: path.join(data, 'claude-config'), CACHE_KEEPER_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : process.platform === 'win32' ? path.join(root, 'node_modules/electron/dist/electron.exe') : path.join(root, 'node_modules/electron/dist/electron');
const target = process.env.CACHE_KEEPER_TEST_EXECUTABLE || electron;
const child = spawn(target, process.env.CACHE_KEEPER_TEST_EXECUTABLE ? [] : [root], { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
await fs.writeFile(path.join(root, '.tmp/ui-smoke-current.json'), JSON.stringify({ data, pid: child.pid, executable: target }, null, 2));
console.log('ISOLATED UI SMOKE:', data, 'pid', child.pid);
let ready = false, readyTimer;
const timeout = setTimeout(() => { console.error('Startup did not become ready in 20 seconds.'); child.kill(); },20000);
let log = '';
child.stdout.on('data',data => {
  process.stdout.write(data); log += data.toString();
  if (!ready && log.includes('CacheKeeper ready')) {
    ready = true; clearTimeout(timeout);
    if (process.argv.includes('--exit-after-ready')) readyTimer = setTimeout(() => child.kill('SIGTERM'),1000);
  }
});
child.stderr.on('data',data => process.stderr.write(data));
child.on('error',error => { console.error(error.message); clearInterval(timer); clearTimeout(timeout); process.exitCode=1; });
child.on('exit', async (code,signal) => {
  clearInterval(timer); clearTimeout(timeout); clearTimeout(readyTimer);
  let tray = null; try { tray=JSON.parse(log.match(/CacheKeeper tray: (\{[^\n]+\})/)?.[1]||'null'); } catch { /* Do not pass a missing native icon check. */ }
  const trayOK = process.platform !== 'darwin' || (tray?.width===18 && tray?.height===18 && tray?.template===true);
  const passed = ready && code === 0 && !signal && trayOK;
  await fs.writeFile(path.join(root,'.tmp/smoke-evidence.json'),JSON.stringify({startup:passed?'PASS':'FAIL',packaged:Boolean(process.env.CACHE_KEEPER_TEST_EXECUTABLE),platform:process.platform,arch:process.arch,ready,exitCode:code,signal,tray,visual:'NOT_RUN',visualReason:'This startup test does not inspect native windows.',apiRequests:'NOT_RUN',realUserConfigurationChanged:false},null,2)+'\n');
  process.exitCode=passed?0:1;
});
process.on('SIGTERM', () => { child.kill(); clearInterval(timer); });
