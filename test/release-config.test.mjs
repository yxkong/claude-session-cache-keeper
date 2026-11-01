import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('Tauri package uses a stable identity, restricted IPC and no bundled sidecar runtime',async()=>{
 const c=JSON.parse(await fs.readFile('src-tauri/tauri.conf.json','utf8')),p=JSON.parse(await fs.readFile('package.json','utf8'));
 assert.equal(c.identifier,'io.yxkong.cachekeeper');assert.equal(c.bundle.externalBin,undefined);assert.equal(p.dependencies.electron,undefined);assert.equal(p.devDependencies.electron,undefined);
 assert.ok(!JSON.stringify(c).includes('dangerousDisableAssetCspModification'));
 const permissions=JSON.parse(await fs.readFile('src-tauri/capabilities/main.json','utf8')).permissions;
 assert.ok(!permissions.some(p=>/fs:|shell:|http:|updater:/.test(p)));
 assert.equal(JSON.parse(await fs.readFile('package-lock.json','utf8')).version,p.version);
});
