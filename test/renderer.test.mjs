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
async function view(t,{demo=true,guideSeen=true,completeGuideError=null,updates=null,update=async()=>{throw new Error('No real update in component tests');}}={}) {
  const dir = await fs.mkdtemp(path.resolve('.tmp/renderer-test-'));
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  const policy = { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0 };
  for (const id of ['a', 'b']) await fs.writeFile(path.join(dir, 'sessions', id + '.json'), JSON.stringify({ schema: 1, id, sessionId: `SID-${id}`, pluginVersion: '0.2.0', title: id === 'a' ? '会话 A' : '会话 B', project: '/synthetic/project', model: 'model-test', active: true, heartbeat: Date.now(), enabled: false, controlRevision: '', policy, attempts: 0, nextAt: 0, lastCacheAt: 0, cacheTokens: 0, phase: 'off', readTokens: 0, writeTokens: 0, outputTokens: 0, lastHit: null }));
  const repo = new BridgeRepository({ roots: [dir], transcriptsRoot: path.join(dir,'transcripts') });
  let stateCalls=0;
  const state = async () => { const sessions=await repo.refresh(); stateCalls++; return {sessions,warnings:[],version:'0.4.0',platform:'darwin',demo,updates,guideSeen}; };
  const dom = new JSDOM(await fs.readFile('app/renderer/index.html', 'utf8'), { runScripts: 'outside-only', url: 'https://synthetic.invalid/' });
  const calls = [], supportCalls=[]; const events={};
  dom.window.cacheKeeper = { state, update:async action=>{updates=await update(action);return updates;},save: async (id, input) => { calls.push({ id, input }); await repo.save(id, input); return state(); }, completeGuide:async()=>{supportCalls.push('complete-guide');if(completeGuideError)throw new Error(completeGuideError);guideSeen=true;},onShowHelp:fn=>{events.help=fn;},onShowAbout:fn=>{events.about=fn;},openResource:async resource=>{supportCalls.push(resource);},copyWechat:async()=>{supportCalls.push('copy-wechat');},copyReload: async () => {supportCalls.push('copy-reload');}, install: async () => { supportCalls.push('install');throw new Error('No real installation in renderer tests'); }, openDocs: async () => {} };
  dom.window.eval(await fs.readFile('dist/renderer/renderer.js','utf8'));
  t.after(async () => { dom.window.close(); await repo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await until(() => dom.window.document.querySelector('[data-session-id="SID-a"]'));
  dom.window.document.querySelector('[data-session-id="SID-a"]').click();
  await until(() => dom.window.document.getElementById('session-title').textContent === '会话 A');
  const field = (id, value) => { const el = dom.window.document.getElementById(id); el.value = String(value); el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const control = async id => JSON.parse(await fs.readFile(path.join(dir,'controls',id+'.json'),'utf8'));
  return { dom, dir, calls, supportCalls, events, field, control, stateCalls:()=>stateCalls, $: id => dom.window.document.getElementById(id) };
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
test('connection dots follow the legend across keepalive outcomes',async t=>{
  const v=await view(t), file=path.join(v.dir,'sessions/a.json');
  const a=JSON.parse(await fs.readFile(file,'utf8'));
  for(const phase of ['waiting','scheduled','sending','limit','expired','tokens','miss','error']){
    Object.assign(a,{enabled:true,busy:false,phase,heartbeat:Date.now()});
    await fs.writeFile(file,JSON.stringify(a));
    const before=v.stateCalls();v.$('refresh').click();await until(()=>v.stateCalls()>before);
    await until(()=>v.$('phase').textContent.includes({waiting:'建立缓存',scheduled:'等待续热',sending:'正在续热',limit:'次数用完',expired:'错过窗口',tokens:'门槛',miss:'未命中',error:'请求失败'}[phase]));
    const dot=v.dom.window.document.querySelector('[data-session-id="SID-a"] .session-dot');
    assert.equal(dot.className,'session-dot online',`${phase}: keepalive outcome must not change the connection legend`);
    assert.equal(v.dom.window.document.querySelector('.status-legend .online').parentElement.textContent,'在线');
  }
});
test('detail explains the actual stop reason and prioritizes current work',async t=>{
  const v=await view(t), file=path.join(v.dir,'sessions/a.json');
  const a=JSON.parse(await fs.readFile(file,'utf8'));
  for(const [phase,reason] of [['miss',/未命中缓存/],['error',/请求失败/],['expired',/错过.*窗口/],['limit',/次数上限/],['tokens',/低于.*门槛/]]){
    Object.assign(a,{enabled:true,busy:false,phase,heartbeat:Date.now()});await fs.writeFile(file,JSON.stringify(a));
    const before=v.stateCalls();v.$('refresh').click();await until(()=>v.stateCalls()>before);
    await until(()=>v.$('phase').textContent.includes({miss:'未命中',error:'请求失败',expired:'错过窗口',limit:'次数用完',tokens:'门槛'}[phase]));
    assert.match(v.$('context-note').textContent,reason);
  }
  Object.assign(a,{busy:true,phase:'waiting',heartbeat:Date.now()});await fs.writeFile(file,JSON.stringify(a));
  const before=v.stateCalls();v.$('refresh').click();await until(()=>v.stateCalls()>before);await until(()=>v.$('phase').textContent.includes('工作中'));
  assert.match(v.$('context-note').textContent,/正在正常工作/);
});
test('update dialog routes plugin-only actions and treats release notes as plain text',async t=>{
  const actions=[],u={phase:'checked',checkedAt:Date.now(),repository:'synthetic-owner/cachekeeper',notes:'<img src=x onerror=alert(1)>',app:{current:'0.3.0',latest:'0.4.0',available:true,downloadable:true,native:false,ready:false},plugin:{current:'0.2.1',bundled:'0.2.1',latest:'0.2.2',available:true,compatible:true,ready:false}};
  const v=await view(t,{demo:false,updates:u,update:async action=>{actions.push(action);if(action==='download-plugin'){u.plugin.ready=true;u.phase='downloaded';}if(action==='apply-plugin'){u.plugin.ready=false;u.plugin.available=false;u.plugin.current='0.2.2';u.message='插件已安装，请手动重载。';}return structuredClone(u);}});
  v.$('updates').click();assert.equal(v.$('updates-dialog').open,true);assert.equal(v.$('release-notes-text').querySelector('img'),null);
  assert.equal(v.$('app-apply').textContent,'打开下载目录');assert.equal(v.$('plugin-apply').disabled,true);
  v.$('plugin-download').click();await until(()=>!v.$('plugin-apply').disabled);v.$('plugin-apply').click();await until(()=>v.$('plugin-update-version').textContent.includes('0.2.2'));
  assert.deepEqual(actions,['download-plugin','apply-plugin']);assert.equal(v.calls.length,0);
});

test('first-run guide explains three steps and completion persists without installing or enabling',async t=>{
  const v=await view(t,{guideSeen:false});
  assert.equal(v.$('guide-dialog').open,true);
  assert.match(v.$('guide-panel-0').textContent,/Claude Code CLI/);assert.match(v.$('guide-panel-0').textContent,/Claude Desktop/);assert.equal(v.$('guide-panel-0').textContent.includes('请先安装 Claude Code CLI'),false);
  assert.match(v.$('guide-title').textContent,/连接/);
  assert.equal(v.$('guide-install').disabled,true,'demo cannot install a real plugin');
  v.$('guide-next').click();
  assert.match(v.$('guide-title').textContent,/会话/);
  v.$('guide-copy-reload').click();await until(()=>v.$('guide-feedback').textContent.includes('已复制'));
  assert.match(v.$('guide-feedback').textContent,/已复制/);assert.equal(v.$('notice').hidden,true,'feedback stays inside the active dialog');
  v.$('guide-next').click();
  assert.match(v.$('guide-title').textContent,/开启/);
  assert.match(v.$('guide-content').textContent,/260～280/);
  assert.match(v.$('guide-content').textContent,/6 次/);
  v.$('guide-next').click();await until(()=>!v.$('guide-dialog').open);
  assert.deepEqual(v.supportCalls,['copy-reload','complete-guide']);assert.equal(v.calls.length,0);
  v.$('refresh').click();await new Promise(r=>setTimeout(r,30));assert.equal(v.$('guide-dialog').open,false);
  v.$('help').click();assert.equal(v.$('guide-dialog').open,true);assert.match(v.$('guide-title').textContent,/连接/);
  v.$('guide-skip').click();await until(()=>!v.$('guide-dialog').open);
  assert.equal(v.supportCalls.filter(x=>x==='complete-guide').length,1,'rereading help need not save again');
});
test('skip and Escape dismiss and acknowledge first-run guide without changing controls',async t=>{
  const v=await view(t,{guideSeen:false});
  const event=new v.dom.window.Event('cancel',{cancelable:true});
  v.$('guide-dialog').dispatchEvent(event);await until(()=>!v.$('guide-dialog').open);
  assert.equal(event.defaultPrevented,true);assert.deepEqual(v.supportCalls,['complete-guide']);assert.equal(v.calls.length,0);
  const other=await view(t,{guideSeen:false});other.$('guide-skip').click();await until(()=>!other.$('guide-dialog').open);
  assert.deepEqual(other.supportCalls,['complete-guide']);assert.equal(other.calls.length,0);
});
test('about, footer links and native menu events share product information and reusable help',async t=>{
  const v=await view(t);
  assert.equal(v.$('guide-dialog').open,false);
  v.$('about').click();assert.equal(v.$('about-dialog').open,true);
  assert.match(v.$('about-version').textContent,/0.4.0/);
  assert.match(v.$('about-repository').textContent,/yxkong\/claude-session-cache-keeper/);
  assert.match(v.$('wechat-name').textContent,/5ycode/);
  v.$('about-github').click();v.$('about-issues').click();v.$('about-wechat-copy').click();
  await until(()=>v.supportCalls.length===3);
  assert.deepEqual(v.supportCalls,['repository','issues','copy-wechat']);
  v.$('about-help').click();assert.equal(v.$('about-dialog').open,false);assert.equal(v.$('guide-dialog').open,true);
  v.$('guide-skip').click();await until(()=>!v.$('guide-dialog').open);
  v.events.about();assert.equal(v.$('about-dialog').open,true);
  v.$('about-close').click();assert.equal(v.$('about-dialog').open,false);
  v.events.help();assert.equal(v.$('guide-dialog').open,true);
  assert.equal(v.calls.length,0);
});
test('guide preference write failure is visible and does not block access to the app',async t=>{
  const v=await view(t,{guideSeen:false,completeGuideError:'合成的写入失败'});
  v.$('guide-skip').click();await until(()=>!v.$('guide-dialog').open);
  assert.match(v.$('notice').textContent,/合成的写入失败/);
  assert.match(v.$('notice').textContent,/下次/);
  assert.equal(v.calls.length,0);
});

test('installation from guide requires a click and shows failure with retry available',async t=>{
  const v=await view(t,{demo:false,guideSeen:false});
  assert.deepEqual(v.supportCalls,[]);assert.equal(v.$('guide-install').disabled,false);
  v.$('guide-install').click();await until(()=>v.$('guide-feedback').textContent.includes('No real installation'));
  assert.deepEqual(v.supportCalls,['install']);assert.equal(v.$('guide-install').disabled,false);
  assert.equal(v.$('guide-dialog').open,true);assert.equal(v.calls.length,0);
});
