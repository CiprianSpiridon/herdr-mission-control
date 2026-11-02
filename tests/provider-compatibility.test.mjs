import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {probeInstalledProviders,verifyLiveReceipt} from '../scripts/provider-compatibility.mjs';
const ID='11111111-1111-4111-8111-111111111111';
async function fixture(t){
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-provider-compat-')));t.after(()=>fs.rm(home,{recursive:true,force:true}));const calls=[],at=new Date().toISOString();
  for(const provider of ['codex','claude','grok'])await fs.mkdir(home+'/.'+provider+'/'+(provider==='claude'?'projects':'sessions'),{recursive:true});
  await fs.writeFile(home+'/.codex/sessions/rollout.jsonl',JSON.stringify({type:'session_meta',payload:{id:ID,cwd:'/fixture/repo',timestamp:at}})+'\n'+JSON.stringify({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{last_token_usage:{total_tokens:20},model_context_window:100}}})+'\n');
  await fs.writeFile(home+'/.claude/projects/session.jsonl',JSON.stringify({type:'assistant',sessionId:ID,cwd:'/fixture/repo',timestamp:at,message:{content:'PRIVATE_PROMPT_MUST_NOT_ESCAPE',usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:0,output_tokens:1}}})+'\n');
  await fs.writeFile(home+'/.grok/sessions/summary.json',JSON.stringify({info:{id:ID,cwd:'/fixture/repo'},last_active_at:at,generated_title:'PRIVATE_TITLE_MUST_NOT_ESCAPE'}));
  const exec=async(command,args)=>{calls.push({command,args});if(args[0]==='--version')return {code:0,stdout:'Synthetic test 1.2.3 PRIVATE_VERSION_SUFFIX'};assert.equal(command,'python3');const p=spawnSync(command,args,{encoding:'utf8',maxBuffer:1048576});return {code:p.status,stdout:p.stdout,stderr:p.stderr};};
  return {home,appHome:home+'/app',exec,calls};
}
test('real fixture files establish parser shape only and cannot pass the live installed gate',async t=>{
  const f=await fixture(t),receipt=await probeInstalledProviders(f);assert.equal(receipt.status,'PASS');assert.equal(receipt.evidenceKind,'synthetic-or-injected-environment');assert.ok(receipt.providers.every(r=>r.schemaStatus==='observed-compatible'));assert.ok(receipt.providers.every(r=>r.measuredActiveContext===0&&r.measuredActiveQuota===0&&r.activeExactBindings===0));assert.throws(()=>verifyLiveReceipt(receipt),/Fixture/);
  const text=JSON.stringify(receipt);for(const privateValue of [ID,f.home,'PRIVATE_PROMPT','PRIVATE_TITLE','PRIVATE_VERSION_SUFFIX'])assert.ok(!text.includes(privateValue));assert.ok(receipt.collectorBytes<=65536);assert.ok(receipt.providers.find(r=>r.provider==='codex').reportedContextFields.includes('windowTokens'));assert.ok(!receipt.providers.find(r=>r.provider==='claude').reportedContextFields.includes('windowTokens'));
});
test('fabricated/deserialized success and injected provenance cannot become measured support',()=>{
  for(const receipt of [{status:'PASS',evidenceKind:'live-installed-metadata'},{status:'PASS',v:1,kind:'installed-provider-compatibility',evidenceKind:'synthetic-or-injected-environment',providers:[{provider:'codex',schemaStatus:'observed-compatible'}]}])assert.throws(()=>verifyLiveReceipt(receipt),/cannot prove/);
});
test('explicitly disabled sources are never probed, listed or read',async t=>{
  const f=await fixture(t);await fs.mkdir(f.appHome+'/mission-control',{recursive:true});await fs.writeFile(f.appHome+'/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:{disabled:{v:1,enabled:false,machine:null,provider:'claude',providerRoot:f.home+'/.claude',credentialScope:'fixture',roots:[f.home+'/.claude/projects']}}}));
  const receipt=await probeInstalledProviders(f);assert.equal(receipt.providers.find(r=>r.provider==='claude').schemaStatus,'disabled');assert.equal(f.calls.filter(c=>c.command==='claude').length,0);assert.equal(f.calls.filter(c=>c.args[0]==='-c'&&JSON.parse(c.args[2]).source.provider==='claude').length,0);assert.equal(receipt.status,'FAIL');
});
test('unsupported schema and malformed private settings stay unsupported without dumping contents',async t=>{
  const f=await fixture(t);await fs.writeFile(f.home+'/.codex/sessions/rollout.jsonl','{"private":"UNSUPPORTED_PRIVATE_SCHEMA"}\n');let receipt=await probeInstalledProviders(f);assert.equal(receipt.providers.find(r=>r.provider==='codex').schemaStatus,'unsupported');assert.equal(receipt.status,'FAIL');assert.ok(!JSON.stringify(receipt).includes('UNSUPPORTED_PRIVATE_SCHEMA'));
  await fs.mkdir(f.appHome+'/mission-control',{recursive:true});const file=f.appHome+'/mission-control/config.json';await fs.writeFile(file,'{"private":"MALFORMED_PRIVATE_CONFIG",');receipt=await probeInstalledProviders(f);assert.equal(receipt.error,'CONFIG_INVALID');assert.ok(!JSON.stringify(receipt).includes('MALFORMED_PRIVATE_CONFIG'));assert.match(await fs.readFile(file,'utf8'),/MALFORMED_PRIVATE_CONFIG/);
});
