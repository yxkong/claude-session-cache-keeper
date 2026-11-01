import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { BridgeRepository } from './native-bridge.mjs';

async function until(check) {
  const end = Date.now() + 2000;
  while (!await check()) { if (Date.now() > end) throw new Error('Renderer condition timed out'); await new Promise(r => setTimeout(r, 10)); }
}
async function view(t,{demo=true,updates=null,update=async()=>{throw new Error('No real update in component tests');}}={}) {
  const dir = await fs.mkdtemp(path.resolve('.tmp/renderer-test-'));
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  const policy = { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0 };
  for (const id of ['a', 'b']) await fs.writeFile(path.join(dir, 'sessions', id + '.json'), JSON.stringify({ schema: 1, id, sessionId: `SID-${id}`, pluginVersion: '0.2.0', title: id === 'a' ? '会话 A' : '会话 B', project: '/synthetic/project', model: 'model-test', active: true, heartbeat: Date.now(), enabled: false, controlRevision: '', policy, attempts: 0, nextAt: 0, lastCacheAt: 0, cacheTokens: 0, phase: 'off', readTokens: 0, writeTokens: 0, outputTokens: 0, lastHit: null }));
  const repo = new BridgeRepository({ roots: [dir], transcriptsRoot: path.join(dir,'transcripts') });
  let stateCalls=0;
  const state = async () => { const sessions=await repo.refresh(); stateCalls++; return {sessions,warnings:[],version:'0.3.0',platform:'darwin',demo,updates}; };
  const dom = new JSDOM(await fs.readFile('app/renderer/index.html', 'utf8'), { runScripts: 'outside-only', url: 'https://synthetic.invalid/' });
  const calls = [];
  dom.window.cacheKeeper = { state, update:async action=>{updates=await update(action);return updates;},save: async (id, input) => { calls.push({ id, input }); await repo.save(id, input); return state(); }, copyReload: async () => {}, install: async () => { throw new Error('No real installation in renderer tests'); }, openDocs: async () => {} };
  dom.window.eval(await fs.readFile('dist/renderer/renderer.js','utf8'));
  t.after(async () => { dom.window.close(); await repo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await until(() => dom.window.document.querySelector('[data-session-id="SID-a"]'));
  dom.window.document.querySelector('[data-session-id="SID-a"]').click();
  await until(() => dom.window.document.getElementById('session-title').textContent === '会话 A');
  const field = (id, value) => { const el = dom.window.document.getElementById(id); el.value = String(value); el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const control = async id => JSON.parse(await fs.readFile(path.join(dir,'controls',id+'.json'),'utf8'));
  return { dom, dir, calls, field, control, stateCalls:()=>stateCalls, $: id => dom.window.document.getElementById(id) };
}
test('saving an off session preserves the new draft without enabling any session', async t => {
  const v = await view(t);
  v.field('minimum',265); v.field('maximum',275); v.field('maximum-attempts',5); v.field('token-threshold',10000);
  v.$('save').click(); await until(() => v.calls.length === 1 && !v.$('save').disabled);
  const control = await v.control('a');
  assert.equal(control.enabled,false); assert.equal(control.policy.minSeconds,265); assert.equal(control.policy.maxAttempts,5);
  await assert.rejects(fs.access(path.join(v.dir,'controls/b.json')));
  v.dom.window.document.querySelector('[data-session-id="SID-b"]').click();
  assert.equal(v.$('notice').hidden,true,'a session-scoped confirmation must not follow the user into another session');
});
test('only the selected session enables, and invalid drafts never block Stop', async t => {
  const v = await view(t);
  v.$('toggle').click(); await until(() => v.$('toggle').textContent === '停止保活' && !v.$('toggle').disabled);
  assert.equal((await v.control('a')).enabled,true);
  await assert.rejects(fs.access(path.join(v.dir,'controls/b.json')));
  v.field('minimum',400);
  assert.equal(v.$('save').disabled,true); assert.equal(v.$('toggle').disabled,false);
  v.$('toggle').click(); await until(() => v.calls.length === 2 && !v.$('toggle').textContent.includes('停止'));
  const stopped = await v.control('a'); assert.equal(stopped.enabled,false); assert.equal(stopped.policy.minSeconds,260);
  assert.equal(v.$('install').disabled,true);
});
test('compact rows keep status in accessible hints and preserve focus on unchanged refresh', async t => {
  const v=await view(t), row=v.dom.window.document.querySelector('[data-session-id="SID-a"]');
  assert.equal(row.textContent,'会话 A'); assert.match(row.title,/SID-a/); assert.match(row.getAttribute('aria-label'),/已关闭/);
  row.focus(); const before=v.stateCalls(); v.$('refresh').click(); await until(()=>v.stateCalls()>before);
  assert.equal(v.dom.window.document.activeElement,row,'refresh must preserve keyboard focus and hover target');
});
test('online and working sessions remain visible when keepalive is off',async t=>{
  const v=await view(t);const a=JSON.parse(await fs.readFile(path.join(v.dir,'sessions/a.json'),'utf8'));
  a.busy=true;await fs.writeFile(path.join(v.dir,'sessions/a.json'),JSON.stringify(a));
  const before=v.stateCalls();v.$('refresh').click();await until(()=>v.stateCalls()>before);
  await until(()=>v.dom.window.document.querySelector('[data-session-id="SID-a"] .session-dot.working'));
  const b=v.dom.window.document.querySelector('[data-session-id="SID-b"] .session-dot');assert.ok(b.classList.contains('online'));
  const row=v.dom.window.document.querySelector('[data-session-id="SID-a"]');assert.match(row.getAttribute('aria-label'),/工作中/);assert.match(row.title,/保活已关闭/);
  v.field('maximum-attempts',12);assert.equal(v.$('save').disabled,false);assert.equal(v.$('maximum-attempts').hasAttribute('max'),false);
});
test('update dialog routes plugin-only actions and treats release notes as plain text',async t=>{
  const actions=[],u={phase:'checked',checkedAt:Date.now(),repository:'synthetic-owner/cachekeeper',notes:'<img src=x onerror=alert(1)>',app:{current:'0.3.0',latest:'0.4.0',available:true,downloadable:true,native:false,ready:false},plugin:{current:'0.2.1',bundled:'0.2.1',latest:'0.2.2',available:true,compatible:true,ready:false}};
  const v=await view(t,{demo:false,updates:u,update:async action=>{actions.push(action);if(action==='download-plugin'){u.plugin.ready=true;u.phase='downloaded';}if(action==='apply-plugin'){u.plugin.ready=false;u.plugin.available=false;u.plugin.current='0.2.2';u.message='插件已安装，请手动重载。';}return structuredClone(u);}});
  v.$('updates').click();assert.equal(v.$('updates-dialog').open,true);assert.equal(v.$('release-notes-text').querySelector('img'),null);
  assert.equal(v.$('app-apply').textContent,'打开下载目录');assert.equal(v.$('plugin-apply').disabled,true);
  v.$('plugin-download').click();await until(()=>!v.$('plugin-apply').disabled);v.$('plugin-apply').click();await until(()=>v.$('plugin-update-version').textContent.includes('0.2.2'));
  assert.deepEqual(actions,['download-plugin','apply-plugin']);assert.equal(v.calls.length,0);
});
