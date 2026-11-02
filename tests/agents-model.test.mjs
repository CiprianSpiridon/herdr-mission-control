import test from 'node:test';
import assert from 'node:assert/strict';
import {agentTitle,buildAgentModel} from '../src/mods/mission-control-agents/model.js';
const program={key:'claude',name:'Claude Code',icon:'icons/claude.svg',tint:true},space=(id,name,machine=null)=>({id,name,machine,tabs:[{id:id+'-tab',name:'1',named:false}]}),agent=(n,status,scope='A')=>({address:'t'+n,space:scope,tab:scope+'-tab',program,title:'Task '+n,tab_name:'1',status});
test('all four priority statuses retain stable ordering and every native navigation address',()=>{
  const agents=[agent(1,'idle'),agent(2,'working'),agent(3,'blocked'),agent(4,'done'),agent(5,'blocked')],model=buildAgentModel({agents,spaces:[space('A','client-portal')]});assert.deepEqual(model.groups.map(g=>g.key),['blocked','done','working','idle']);assert.deepEqual(model.rows.map(r=>r.address),['t3','t5','t4','t2','t1']);assert.deepEqual(model.navigation,model.rows.map(r=>r.address));assert.equal(model.count,5);
});
test('task titles respect explicit manual ownership and never default to tool names',()=>{
  const a={program,title:'Claude Code',tab_name:'Claude Code'};assert.equal(agentTitle(a),'Agent');assert.equal(agentTitle({...a,title:'Fix login'}),'Fix login');assert.equal(agentTitle(a,{ownership:{mode:'auto',lastAutoName:'WEB-142 Fix login'}}),'WEB-142 Fix login');assert.equal(agentTitle(a,{ownership:{mode:'manual',manualName:'My work'}}),'My work');assert.equal(agentTitle(a,{taskTitle:'Review PR 42'}),'Review PR 42');
  assert.equal(agentTitle({...a,title:'/work/client-portal'}),'Agent');assert.equal(agentTitle(a,{ownership:{mode:'manual',manualName:'Claude Code'}}),'Claude Code','An explicit user name is preserved');
});
test('same names/local addresses across machines remain separate in space grouping',()=>{
  const agents=[agent(1,'working','A'),agent(1,'idle','server/B')],spaces=[space('A','same-name'),space('server/B','same-name','server')],model=buildAgentModel({agents,spaces,mode:'spaces'});assert.equal(model.groups.length,2);assert.deepEqual(model.rows.map(r=>r.address),['t1','server/t1']);assert.deepEqual(model.rows.map(r=>r.focus.args.terminal),['t1','server/t1']);assert.ok(model.rows.every(r=>r.context.state==='unavailable'&&r.quota.state==='unavailable'));assert.equal(new Set(model.navigation).size,2);
});
test('sub-agent urgency, explicit peek focus and cycles preserve parent/child identities',()=>{
  const agents=[agent(1,'working'),agent(4,'done')],terminals=[{address:'t1',state:'live'},{address:'t2',parent:'t1',state:'live',status:'error',name:'Blocked child',program},{address:'t3',parent:'t2',state:'live',status:'done',name:'Completed child',program},{address:'t1',parent:'t3',state:'live'}],model=buildAgentModel({agents,terminals,spaces:[space('A','repo')]});assert.equal(model.groups[0].key,'blocked');assert.deepEqual(model.rows.slice(0,3).map(r=>[r.address,r.depth]),[['t1',0],['t2',1],['t3',2]]);assert.equal(model.rows.find(r=>r.address==='t2').focus.command,'terminal.peek');assert.equal(model.rows.find(r=>r.address==='t3').status,'idle');assert.deepEqual(model.navigation,['t1','t4']);
  const filtered=buildAgentModel({agents,terminals,spaces:[space('A','repo')],query:'Blocked child',folded:new Set(['t1'])});assert.deepEqual(filtered.rows.map(r=>r.address),['t1','t2']);
});
test('unknown metrics are explicit and reported versus estimated context remains visible',()=>{
  const agents=[agent(1,'working')],readings=new Map([['t1',{context:{state:'available',remainingPercent:60,basis:'estimate',reason:'Compaction threshold unknown'},quota:{state:'available',scope:'shared-account',identity:{credentialScope:'work',accountId:'a'.repeat(64)},windows:[{name:'five_hour',remainingPercent:40},{name:'weekly',remainingPercent:20}],reason:'Shared allowance'}}]]),model=buildAgentModel({agents,spaces:[space('A','repo')],readings});assert.equal(model.rows[0].context.percent,60);assert.equal(model.rows[0].context.estimated,true);assert.equal(model.rows[0].quota.percent,20);assert.match(model.rows[0].quota.scope,/Shared account/);
  const missing=buildAgentModel({agents,spaces:[]});assert.equal(missing.rows[0].focus,null);assert.equal(missing.rows[0].context.percent,null);assert.equal(missing.rows[0].quota.percent,null);
});
test('dozens of agents remain searchable with native navigation containing all visible rows first',()=>{
  const agents=Array.from({length:64},(_,i)=>agent(i+1,['blocked','done','working','idle'][i%4])),model=buildAgentModel({agents,spaces:[space('A','repo')],query:'Task 64'});assert.equal(model.rows.length,1);assert.equal(model.navigation[0],'t64');assert.equal(new Set(model.navigation).size,64);
});
test('alphanumeric child addresses remain visible and retain their own peek target',()=>{
  const model=buildAgentModel({agents:[agent(1,'working')],spaces:[space('A','repo')],terminals:[{address:'t1b',parent:'t1',state:'live',status:'working',name:'Alphabetic child',program}]});assert.equal(model.rows[1].address,'t1b');assert.deepEqual(model.rows[1].focus.args,{terminal:'t1b'});
});
