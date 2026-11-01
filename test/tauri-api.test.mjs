import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';
test('native string errors retain their message for the existing renderer',async t=>{
  const dom=new JSDOM('',{runScripts:'outside-only'});t.after(()=>dom.window.close());
  dom.window.__TAURI_INTERNALS__={invoke:async()=>{throw '会话已离线，不能开启保活。';}};
  dom.window.eval(await fs.readFile('dist/renderer/tauri-api.js','utf8'));
  let rejected=false;try{await dom.window.cacheKeeper.state();}catch(error){rejected=true;assert.equal(error.message,'会话已离线，不能开启保活。');}assert.equal(rejected,true);
});
