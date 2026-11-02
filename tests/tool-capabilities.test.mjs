import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {parseCapabilities,probeCapabilities,buildArguments,CapabilityRegistry} from '../src/shared/tool-capabilities.js';
const tool=key=>({key,run:[key],installed:true});
const id='019c7714-3b77-74d1-9866-e1f484aae2ab';
test('Claude verified options and exact IDs never substitute continue/last',()=>{
  const c=parseCapabilities(tool('claude'),{help:'Claude Code\nUsage: claude [options] [prompt]\n  --model <model>\n  --effort <level> (low, medium, high, xhigh, max)\n  --resume [value]\n  --session-id <uuid>\n  --append-system-prompt <prompt>'});
  assert.deepEqual(buildArguments(c,{resumeSessionId:id,options:{model:'opus',reasoning:'high'}}),['claude','--resume',id,'--model','opus','--effort','high']);
  assert.throws(()=>buildArguments(c,{resumeSessionId:'last'}),/exact/);
  assert.throws(()=>buildArguments(c,{newSessionId:id,resumeSessionId:id}),/mutually/);
});
test('Codex foreground/exact resume is verified and arbitrary config reasoning is unavailable',()=>{
  const c=parseCapabilities(tool('codex'),{help:'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n  --no-daemon\n  -m, --model <MODEL>',resumeHelp:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'});
  assert.deepEqual(buildArguments(c,{resumeSessionId:id}),['codex','--no-daemon','resume',id]);
  assert.throws(()=>buildArguments(c,{options:{reasoning:'high'}}),/unavailable/);
});
test('failed direct help leaves installed shell-wrapper base launch available',async()=>{
  const wrapper={key:'claude',run:['my-claude','--profile','work'],installed:true};
  const c=await probeCapabilities(wrapper,{exec:async()=>{throw Error('function is not a direct executable');}});
  assert.deepEqual(buildArguments(c),wrapper.run);assert.equal(c.provider,null);assert.throws(()=>buildArguments(c,{options:{model:'opus'}}),/unavailable/);
  assert.throws(()=>buildArguments(c,{options:{flags:'--yolo'}}));
});
test('capability caches separate machine/run/version and recheck changed installation',async()=>{
  let now=0,calls=[];const registry=new CapabilityRegistry(async(cmd,args,options)=>{calls.push({cmd,args,options});return {code:0,stdout:args[0]==='--version'?'version 1':'Grok Build TUI\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>\n --resume [<SESSION_ID_OR_TITLE>]\n --session-id <SESSION_ID>\n --reasoning-effort <EFFORT>'};},{clock:()=>now,ttl:10});
  const a=await registry.get(tool('grok')),b=await registry.get(tool('grok'),'server');assert.notEqual(a.cacheKey,b.cacheKey);assert.equal(calls.length,4);
  await registry.get(tool('grok'));assert.equal(calls.length,4);now=20;await registry.get(tool('grok'));assert.equal(calls.length,6);
  await assert.rejects(registry.get({...tool('grok'),installed:false}));
});
test('installed local help confirms providers without invoking a paid task',()=>{
  for(const key of ['claude','codex','grok']){
    const help=spawnSync(key,['--help'],{encoding:'utf8',timeout:10000});
    if(help.error?.code==='ENOENT')continue;
    assert.equal(help.status,0,key);const resume=key==='codex'?spawnSync(key,['resume','--help'],{encoding:'utf8',timeout:10000}).stdout:'';
    const c=parseCapabilities(tool(key),{help:help.stdout,resumeHelp:resume});assert.equal(c.provider,key);assert.ok(c.model);assert.ok(c.resume);
    if(key==='codex')assert.equal(c.foregroundFlag,'--no-daemon');
    else assert.equal(c.callerSession,'--session-id');
  }
});
