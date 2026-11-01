import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stageMacApp } from '../scripts/lib/macos-stage.mjs';

test('repeated Mac staging preserves relative framework links and removes stale files', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.resolve('.tmp/staging-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const source = path.join(root,'CacheKeeper.app'), stage = path.join(root,'stage');
  const framework = 'Contents/Frameworks/Example.framework';
  await fs.mkdir(path.join(source,framework,'Versions/A'),{recursive:true});
  await fs.writeFile(path.join(source,framework,'Versions/A/Example'),'first');
  await fs.symlink('A',path.join(source,framework,'Versions/Current'));
  await fs.symlink('Versions/Current/Example',path.join(source,framework,'Example'));
  await stageMacApp(source,stage);
  const staged = path.join(stage,'CacheKeeper.app',framework,'Example');
  assert.equal(await fs.readlink(staged),'Versions/Current/Example');
  await fs.writeFile(path.join(stage,'stale.txt'),'old build');
  await fs.writeFile(path.join(source,framework,'Versions/A/Example'),'second');
  await stageMacApp(source,stage);
  assert.equal(await fs.readlink(staged),'Versions/Current/Example');
  assert.equal(await fs.readFile(staged,'utf8'),'second');
  await assert.rejects(fs.access(path.join(stage,'stale.txt')));
  assert.equal(await fs.readlink(path.join(source,framework,'Example')),'Versions/Current/Example');
});
