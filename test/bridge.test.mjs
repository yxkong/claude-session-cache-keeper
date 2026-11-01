import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeRepository } from '../app/core/bridge.mjs';

const fresh = async t => {
  const dir = await fs.mkdtemp(path.resolve('.tmp/bridge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  const write = async (id, extra = {}) => fs.writeFile(path.join(dir, 'sessions', `${id}.json`), JSON.stringify({ schema: 1, id, sessionId: `SID-${id}`, pluginVersion: '0.2.0', title: 'Synthetic session', project: '/work/demo', model: 'model-test', active: true, heartbeat: Date.now(), enabled: false, controlRevision: '', policy: { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0 }, attempts: 0, nextAt: 0, lastCacheAt: 0, cacheTokens: 0, phase: 'off', readTokens: 0, writeTokens: 0, outputTokens: 0, lastHit: null, ...extra }));
  return { dir, write, repo: new BridgeRepository({ roots: [dir], transcriptsRoot: path.join(dir, 'transcripts') }) };
};

test('only explicitly selected online sessions receive control files', async t => {
  const w = await fresh(t); await w.write('a'); await w.write('b');
  const state = await w.repo.refresh(); assert.equal(state.length, 2);
  await w.repo.save('a', { enabled: true, policy: state.find(s => s.id === 'a').policy });
  const control = JSON.parse(await fs.readFile(path.join(w.dir, 'controls/a.json')));
  assert.equal(control.enabled, true); assert.equal(control.id, 'a');
  await assert.rejects(fs.access(path.join(w.dir, 'controls/b.json')));
});
test('stale, foreign IDs, invalid policy and path traversal cannot spend', async t => {
  const w = await fresh(t); await w.write('a', { heartbeat: Date.now() - 60_000 }); await w.repo.refresh();
  const policy = { minSeconds: 260, maxSeconds: 280, maxAttempts: 6, minCachedTokens: 0 };
  await assert.rejects(w.repo.save('a', { enabled: true, policy }), /离线/);
  await assert.rejects(w.repo.save('../escape', { enabled: true, policy }));
  await assert.rejects(w.repo.save('missing', { enabled: true, policy }));
  await assert.rejects(w.repo.save('a', { enabled: true, policy: { ...policy, maxAttempts: 0 } }));
});
test('partial status writes preserve the last valid snapshot', async t => {
  const w = await fresh(t); await w.write('a'); await w.repo.refresh();
  await fs.writeFile(path.join(w.dir, 'sessions/a.json'), '{');
  const state = await w.repo.refresh(); assert.equal(state[0].sessionId, 'SID-a');
});
test('custom attempt budgets require the upgraded executor and never silently fall back to six',async t=>{
  const w=await fresh(t);await w.write('a');let [s]=await w.repo.refresh();
  await assert.rejects(w.repo.save('a',{enabled:false,policy:{...s.policy,maxAttempts:99}}),/旧执行器/);
  await w.write('a',{pluginVersion:'0.2.1',capabilities:{customAttemptBudget:true}});[s]=await w.repo.refresh();
  await w.repo.save('a',{enabled:false,policy:{...s.policy,maxAttempts:99}});
  assert.equal(JSON.parse(await fs.readFile(path.join(w.dir,'controls/a.json'),'utf8')).policy.maxAttempts,99);
});
test('legacy connections can be stopped but cannot be enabled by the new app', async t => {
  const w = await fresh(t); await w.write('a', { pluginVersion: '0.1.2', enabled: true }); const [s] = await w.repo.refresh();
  await assert.rejects(w.repo.save('a', { enabled: true, policy: s.policy }), /旧版/);
  await w.repo.save('a', { enabled: false, policy: s.policy });
  assert.equal(JSON.parse(await fs.readFile(path.join(w.dir, 'controls/a.json'))).enabled, false);
});
test('real transcript title metadata wins over directory names and body text', async t => {
  const w = await fresh(t); await w.write('a', { title: 'project' });
  const dir = path.join(w.dir, 'transcripts/project'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SID-a.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'custom-title', customTitle: '正确会话名称' }) + '\n' + JSON.stringify({ type: 'user', message: { content: '{"type":"custom-title","customTitle":"wrong"}' } }) + '\n');
  assert.equal((await w.repo.refresh())[0].title, '正确会话名称');
  await fs.appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: '已重命名的会话' }) + '\n');
  assert.equal((await w.repo.refresh())[0].title, '已重命名的会话');
});
