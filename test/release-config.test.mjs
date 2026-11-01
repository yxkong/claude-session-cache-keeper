import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('missing CI signing secret does not become the project directory as a certificate path',()=>{
  const inspect=value=>JSON.parse(execFileSync(process.execPath,['-e',"const c=require('./electron-builder.config.cjs');console.log(JSON.stringify({link:process.env.CSC_LINK,identity:c.mac.identity,publish:c.publish.repo}))"],{encoding:'utf8',env:{...process.env,CSC_LINK:value,CACHE_KEEPER_NATIVE_UPDATES:'0'}}));
  const empty=inspect('');assert.equal(empty.link,undefined);assert.equal(empty.identity,'-');assert.equal(empty.publish,'claude-session-cache-keeper');
  assert.equal(inspect('synthetic-signing-reference').link,'synthetic-signing-reference');
});
