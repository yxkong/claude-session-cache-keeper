import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,validatePolicy,fresh,configure,mainStarted,mainAnswered,mainFinished,due,beginAttempt,finishAttempt} from '../plugin/hooks/policy.ts';
test('six is a recommendation; a configured twelve-attempt budget permits the seventh and stops after twelve',()=>{
  assert.equal(defaults.maxAttempts,6);assert.equal(validatePolicy({...defaults,maxAttempts:99}),true);
  const s=fresh(),usage={input_tokens:0,output_tokens:1,cache_read_input_tokens:100000,cache_creation_input_tokens:0},start=1000000;
  configure(s,{...defaults,maxAttempts:12},true,start,()=>0);mainStarted(s,start);mainAnswered(s,usage,start);mainFinished(s,start,()=>0);
  for(let i=1;i<=12;i++){const at=start+i*260000;assert.equal(due(s,at),true);finishAttempt(s,usage,at,beginAttempt(s),()=>0);assert.equal(s.attempts,i);}
  assert.equal(due(s,start+13*260000),false);assert.equal(s.phase,'limit');
  for(const value of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])assert.equal(validatePolicy({...defaults,maxAttempts:value}),false);
});
