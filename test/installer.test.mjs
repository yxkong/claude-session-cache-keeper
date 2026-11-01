import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PluginInstaller, runCLI } from '../app/core/cli.mjs';
const fake = async t => {
  const base = await fs.mkdtemp(path.resolve('.tmp/installer-test-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const resources = path.join(base, 'bundled');
  for (const file of ['plugin/.claude-plugin/plugin.json','plugin/.claude-plugin/icon.png','plugin/hooks/hooks.json','plugin/hooks/register.ts','plugin/hooks/policy.ts','plugin/LICENSE','plugin/THIRD_PARTY_NOTICES.md','.claude-plugin/marketplace.json']) {
    await fs.mkdir(path.dirname(path.join(resources,file)), { recursive: true }); await fs.writeFile(path.join(resources,file), file.endsWith('plugin.json') ? '{"version":"0.2.1"}' : 'synthetic');
  }
  return { base, resources };
};
test('installation uses a stable data-directory source and only migrates our legacy plugin', async t => {
  const f = await fake(t), calls = [], events = [];
  const run = async (_exe, args) => { calls.push(args); if (args[1] === 'list') return JSON.stringify([{ id: 'unrelated@tools', enabled: true }, { id: 'session-cache-keeper@personal-cache-tools', enabled: true }]); return '{"outcome":"ok"}'; };
  const installer = new PluginInstaller({ resources: f.resources, dataRoot: path.join(f.base,'user data'), repository: { stopAll: async options => events.push(options) }, cli: 'synthetic-cli', run });
  await installer.install();
  assert.deepEqual(events, [{ legacyOnly: true }]);
  assert.ok(calls.some(a => a[1] === 'disable' && a[2] === 'session-cache-keeper@personal-cache-tools'));
  assert.ok(!calls.some(a => a.includes('unrelated@tools') && a[1] !== 'list'));
  const install = calls.find(a => a[1] === 'install');
  assert.equal(install[install.indexOf('--marketplace') + 1], path.join(f.base,'user data/marketplace'));
  assert.equal(await fs.readFile(path.join(f.base,'user data/marketplace/plugin/hooks/register.ts'),'utf8'), 'synthetic');
});
test('an older bundled connector cannot downgrade a remotely updated installation',async t=>{
  const f=await fake(t);let mutations=0;
  const installer=new PluginInstaller({resources:f.resources,dataRoot:path.join(f.base,'state'),cli:'synthetic',run:async(_e,a)=>{if(a[1]==='list')return JSON.stringify([{id:'session-cache-keeper@yxkong-cache-tools',version:'0.3.0'}]);mutations++;return '{"outcome":"ok"}';}});
  await assert.rejects(installer.install(),/拒绝降级/);assert.equal(mutations,0);
});
test('failed plugin updates restore the previous marketplace files',async t=>{
  const f=await fake(t),root=path.join(f.base,'state');await fs.mkdir(path.join(root,'marketplace'),{recursive:true});await fs.writeFile(path.join(root,'marketplace/previous.txt'),'previous');
  const installer=new PluginInstaller({resources:f.resources,dataRoot:root,cli:'synthetic',run:async(_e,a)=>{if(a[1]==='list')return '[]';throw new Error('Synthetic failure');}});
  await assert.rejects(installer.install(),/Synthetic failure/);assert.equal(await fs.readFile(path.join(root,'marketplace/previous.txt'),'utf8'),'previous');
});
test('a failed install restores only the previously enabled legacy plugin', async t => {
  const f = await fake(t), calls = [];
  const run = async (_exe, args) => { calls.push(args); if (args[1] === 'list') return JSON.stringify([{ id: 'session-cache-keeper@personal-cache-tools', enabled: true }]); if (args[1] === 'install') throw new Error('Synthetic install failed'); return ''; };
  const installer = new PluginInstaller({ resources: f.resources, dataRoot: path.join(f.base,'state'), repository: { stopAll: async () => {} }, cli: 'synthetic-cli', run });
  await assert.rejects(installer.install(), /Synthetic install failed/);
  assert.ok(calls.some(a => a[1] === 'enable' && a[2] === 'session-cache-keeper@personal-cache-tools'));
  assert.equal(installer.busy, false);
});
test('CLI execution preserves argument boundaries including spaces and shell characters', async () => {
  const value = 'synthetic path with spaces & $(echo invalid)';
  const output = await runCLI(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', value]);
  assert.deepEqual(JSON.parse(output), [value]);
});

test('an update failure cannot leave the new and legacy connectors both enabled', async t => {
  const f = await fake(t), calls = [];
  const run = async (_exe,args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify([{ id: 'session-cache-keeper@personal-cache-tools', enabled:true }, { id:'session-cache-keeper@yxkong-cache-tools', enabled:false }]);
    if (args[1] === 'update') throw new Error('Synthetic update failed');
    return '{"outcome":"ok"}';
  };
  const installer = new PluginInstaller({ resources:f.resources,dataRoot:path.join(f.base,'state'),repository:{ stopAll:async()=>{} },cli:'synthetic-cli',run });
  await assert.rejects(installer.install(),/Synthetic update failed/);
  const disableNew = calls.findIndex(a => a[1] === 'disable' && a[2] === 'session-cache-keeper@yxkong-cache-tools');
  const enableOld = calls.findIndex(a => a[1] === 'enable' && a[2] === 'session-cache-keeper@personal-cache-tools');
  assert.ok(disableNew >= 0 && enableOld > disableNew);
});
