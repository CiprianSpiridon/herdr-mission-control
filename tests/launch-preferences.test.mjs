import test from 'node:test';
import assert from 'node:assert/strict';
import {toolChoices,validateLaunchPreferences,validateToolOptions} from '../src/shared/launch-preferences.js';
const tools=['kiro','grok','claude','codex','cursor'].map(key=>({key,name:key,run:[key],installed:true}));
test('defaults use three installed Claude/Codex/Grok pins and searchable overflow',()=>{
  const c=toolChoices(tools);assert.deepEqual(c.quick.map(t=>t.key),['claude','codex','grok']);assert.equal(c.overflow.length,2);assert.deepEqual(toolChoices(tools,{},'kir').all.map(t=>t.key),['kiro']);
});
test('saved pins/order/hiding survive host reconciliation without launching unavailable tools',()=>{
  const p={v:1,pins:['cursor','codex','claude'],hidden:['claude']};
  assert.deepEqual(toolChoices(tools,p).quick.map(t=>t.key),['cursor','codex']);
  const remote=tools.map(t=>({...t,installed:t.key==='grok'}));assert.deepEqual(toolChoices(remote,p).quick,[]);assert.deepEqual(toolChoices(remote,p).all.map(t=>t.key),['grok']);
  assert.deepEqual(toolChoices(tools,{pins:[]}).quick,[]);
});
test('invalid options and pin identities fail before launch',()=>{
  for(const p of [{pins:['a','b','c','d']},{pins:['a','a']},{pins:['../a']},{worktree:'yes'},{tools:{codex:{flags:'--yolo'}}}])assert.throws(()=>validateLaunchPreferences(p));
  for(const p of [{model:''},{reasoning:'high\n--flag'},{subagents:'yes'},{skill:'../\n'}])assert.throws(()=>validateToolOptions(p));
  assert.equal(validateLaunchPreferences({tools:{codex:{model:'gpt-6.1-sol'}}}).tools.codex.model,'gpt-6.1-sol');
});
