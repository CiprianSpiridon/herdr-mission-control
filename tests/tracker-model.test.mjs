import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {newConfig,bindingKey,readConfig} from '../src/shared/config.js';
import {TrackerModelError,trackerOrigin,validateRepoBinding,validateStatusMapping,trackerScope,trackerScopeKey,selectTracker,allTrackerBindings,validateIssue,validateSnapshot,issueIdentityKey,groupIssues,mappedStatus,aggregateIssues,ScopedTrackerCache,saveRepoIntegration} from '../src/shared/tracker-model.js';

const NOW=1800000000000;
const connection=(id='work',site='https://work.atlassian.net')=>({id,kind:'api',site,auth:{kind:'basic',usernameEnv:'JIRA_USER',tokenEnv:id==='work'?'WORK_TOKEN':'PERSONAL_TOKEN'}});
const binding=(id='work',machine=null,repoRoot='/repos/client-portal')=>({machine,repoRoot,jira:{connectionId:id,project:'WEB'}});
const makeScope=(c=connection(),b=binding())=>trackerScope('jira',c,b);
const issue=(n=142,group='todo',c=connection(),b=binding())=>({identity:{kind:'jira',connectionId:c.id,site:trackerOrigin(c.site),id:String(10000+n)},key:'WEB-'+n,title:'Fix login redirect '+n,url:trackerOrigin(c.site)+'/browse/WEB-'+n,body:'Source task data.\nSecond line.',statusGroup:group,statusName:{todo:'To do',inProgress:'Developing',done:'Resolved'}[group],priority:'High',repoBinding:b,updatedAt:NOW-1000});
const snapshot=(scope=makeScope(),data=[issue()])=>({data,fetchedAt:NOW,scope,truncated:false});
function config(){const c=newConfig();for(const conn of [connection(),connection('personal','https://personal.atlassian.net')])c.connections[conn.id]=conn;for(const b of [binding(),binding('personal','server','/srv/client-portal')])c.bindings[bindingKey(b.machine,b.repoRoot)]=b;return c;}

test('To do, In progress and Done are preserved; source status filters compose with text search',()=>{
  const rows=[issue(142,'todo'),issue(143,'inProgress'),issue(144,'done')].map(v=>validateIssue(v,{scope:makeScope()}));
  const all=groupIssues(rows);assert.deepEqual(Object.values(all).map(v=>v.length),[1,1,1]);assert.equal(groupIssues(rows,{query:'WEB-144',status:'done'}).done.length,1);assert.deepEqual(Object.values(groupIssues(rows,{query:'WEB-144',status:'todo'})).flat(),[]);
  assert.equal(mappedStatus('resolved',{todo:['open'],inProgress:['developing'],done:['resolved']}),'done');assert.throws(()=>mappedStatus('mystery',{todo:['open'],inProgress:['developing'],done:['resolved']}),e=>e.code==='STATUS_MAPPING_REQUIRED');
  assert.throws(()=>mappedStatus('open',{todo:['open','dup'],inProgress:['dup'],done:[]}),TrackerModelError);assert.throws(()=>groupIssues(rows,{status:'running-agent'}),TrackerModelError);
});
test('identical source IDs across sites, accounts and repository hosts remain distinct in All spaces',()=>{
  const c=connection(),b=binding(),other=connection('personal','https://personal.atlassian.net'),remote=binding('work','server','/srv/client-portal');
  const rows=[issue(142,'todo',c,b),issue(142,'todo',other,binding('personal')),issue(142,'todo',c,remote)];assert.equal(new Set(rows.map(issueIdentityKey)).size,3);
  const merged=aggregateIssues([{data:rows,truncated:false},{data:[rows[0]],truncated:false}]);assert.equal(merged.data.length,3);assert.equal(merged.truncated,false);assert.equal(aggregateIssues([{data:rows,truncated:false}],{limit:2}).truncated,true);
  const all=allTrackerBindings(config());assert.equal(all.length,2);assert.deepEqual(all.map(v=>[v.binding.machine,v.connection.id]),[[null,'work'],['server','personal']]);
  assert.equal(selectTracker(config(),{state:'ambiguous',machine:null,repoRoot:b.repoRoot}),null);assert.equal(selectTracker(config(),{state:'resolved',machine:null,repoRoot:'/another'}),null);
});
test('scope fingerprints include project/JQL and credential references and ignore object key order',()=>{
  const c=connection(),b=binding(),first=makeScope(c,b),reordered=makeScope({auth:c.auth,site:c.site,kind:c.kind,id:c.id},b);
  assert.equal(trackerScopeKey(first),trackerScopeKey(reordered));
  for(const next of [makeScope({...c,auth:{...c.auth,tokenEnv:'NEW_ACCOUNT_TOKEN'}},b),makeScope({...c,auth:{...c.auth,usernameEnv:'OTHER_JIRA_USER'}},b),makeScope({...c,cloudId:'11111111-2222-3333-4444-555555555555'},b),makeScope(c,{...b,jira:{...b.jira,project:'OPS'}}),makeScope(c,{...b,jira:{connectionId:'work',jql:'project in (WEB, OPS)'}})])assert.notEqual(trackerScopeKey(first),trackerScopeKey(next));
  const cloud=makeScope({...c,cloudId:'11111111-2222-3333-4444-555555555555'},b),otherCloud=makeScope({...c,cloudId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},b);assert.notEqual(trackerScopeKey(cloud),trackerScopeKey(otherCloud));
  const cache=new ScopedTrackerCache({clock:()=>NOW});cache.accept(cache.begin(cloud),snapshot(cloud));const pending=cache.begin(cloud);cache.select(otherCloud);assert.equal(cache.snapshot,null);assert.equal(cache.accept(pending,snapshot(cloud)),false);
  assert.equal(trackerOrigin('https://EXAMPLE.net:443/'),'https://example.net');for(const site of ['http://example.net','https://user:pass@example.net','https://example.net/path','https://example.net#x','https://127.0.0.999'])assert.throws(()=>trackerOrigin(site),TrackerModelError);
});
test('invalid status, issue URL, identity, body controls or binding cannot become launchable cards',()=>{
  const base=issue();for(const mutate of [v=>v.statusGroup='running',v=>v.url='javascript:alert(1)',v=>v.url='https://other.atlassian.net/browse/WEB-142',v=>v.url='https://work.atlassian.net/browse/OPS-2',v=>v.identity.site='https://work.atlassian.net/',v=>v.identity.connectionId='personal',v=>v.repoBinding.machine='server',v=>v.repoBinding.repoRoot='/other',v=>v.body='\x1b[2J',v=>v.title='',v=>v.updatedAt=9000000000000000]){const value=structuredClone(base);mutate(value);assert.throws(()=>validateIssue(value,{scope:makeScope()}),TrackerModelError);}
  assert.throws(()=>validateRepoBinding({...binding(),repoRoot:'../repo'}),TrackerModelError);assert.throws(()=>validateIssue({...base,body:'🙂'.repeat(16001)}),TrackerModelError);
});
test('GitHub issue links retain the exact repository and explicit labels/Projects mappings',()=>{
  const b={machine:null,repoRoot:'/repo',github:{connectionId:'gh-work',owner:'Acme',repo:'Web'}},c={id:'gh-work',kind:'github',site:'https://github.com',credentialEnv:'GH_WORK_TOKEN'},s=trackerScope('github',c,b),row={...issue(),identity:{kind:'github',connectionId:c.id,site:c.site,id:'stable-node-id'},key:'GH-38',url:'https://github.com/acme/web/issues/38',repoBinding:b};
  assert.equal(validateIssue(row,{scope:s}).identity.id,'stable-node-id');assert.throws(()=>validateIssue({...row,url:'https://github.com/acme/other/issues/38'},{scope:s}),TrackerModelError);
  assert.deepEqual(validateStatusMapping({labels:{todo:['Ready'],inProgress:['Working'],done:['Done']}}).labels.done,['Done']);assert.throws(()=>validateStatusMapping({labels:{todo:['Ready'],inProgress:['ready'],done:[]}}),TrackerModelError);
  const project={owner:'Acme',number:1,fieldId:'PVTSSF_1',options:{todo:['opt-ready'],inProgress:['opt-working'],done:['opt-done']},unmapped:'error'};assert.equal(validateStatusMapping({project}).project.fieldId,'PVTSSF_1');assert.throws(()=>validateStatusMapping({project:{...project,options:{...project.options,done:['opt-working']}}}),TrackerModelError);assert.throws(()=>validateStatusMapping({project:{...project,unmapped:'guess'}}),TrackerModelError);
});
test('account switch clears old cards immediately and late responses cannot publish into the new scope',()=>{
  const cache=new ScopedTrackerCache({clock:()=>NOW}),a=makeScope(),b=makeScope(connection('personal','https://personal.atlassian.net'),binding('personal')),first=cache.begin(a);assert.equal(cache.begin(a),null);assert.equal(cache.accept(first,snapshot(a)),true);assert.equal(cache.snapshot.data.length,1);
  const pending=cache.begin(a);cache.select(b);assert.equal(cache.snapshot,null);assert.equal(cache.accept(pending,snapshot(a)),false);const fresh=cache.begin(b);assert.equal(cache.accept(fresh,snapshot(b,[issue(142,'done',connection('personal','https://personal.atlassian.net'),binding('personal'))])),true);assert.equal(cache.snapshot.data[0].identity.connectionId,'personal');
  const next=cache.begin(b);assert.equal(cache.accept(fresh,snapshot(b,[])),false,'an old accepted ticket cannot overwrite a newer in-flight refresh');assert.equal(cache.accept(next,snapshot(b,[])),true);
});
test('same-scope failure retains timestamped real cards; malformed pages and replayed cursors fail',()=>{
  const s=makeScope(),cache=new ScopedTrackerCache({clock:()=>NOW});assert.equal(cache.accept(cache.begin(s),snapshot(s)),true);const timestamp=cache.snapshot.fetchedAt;cache.fail(cache.begin(s),{code:'RATE_LIMITED',message:'Retry the selected account.',retryAt:NOW+2000});assert.equal(cache.snapshot.fetchedAt,timestamp);assert.equal(cache.snapshot.data.length,1);assert.equal(cache.snapshot.error.code,'RATE_LIMITED');
  for(const value of [{...snapshot(),scope:makeScope(connection('personal'),binding('personal'))},{...snapshot(),data:[issue(),issue()]},{...snapshot(),cursor:'opaque-token',truncated:false},{...snapshot(),fetchedAt:NOW+6000},{...snapshot(),data:Array.from({length:1001},(_,i)=>issue(i+1))}])assert.throws(()=>validateSnapshot(value,s,{now:NOW}),TrackerModelError);
  const valid=validateSnapshot({...snapshot(),cursor:'opaque-token',truncated:true},s,{now:NOW});assert.equal(valid.truncated,true);
});
test('repo setup uses real CAS persistence and preserves other sources, profiles and machines',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-tracker-config-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/mission-control');const file=root+'/mission-control/config.json',initial=config();initial.connections['gh-work']={id:'gh-work',kind:'github',site:'https://github.com',credentialEnv:'GH_WORK_TOKEN'};initial.bindings[bindingKey(null,'/repos/client-portal')].github={connectionId:'gh-work',owner:'Acme',repo:'Web'};await fs.writeFile(file,JSON.stringify(initial));
  const io={appHome:()=>root,readTextFile:async p=>fs.readFile(p,'utf8'),writeTextFile:async(p,text,expected)=>{assert.equal(sync.readFileSync(p,'utf8'),expected);sync.writeFileSync(p,text);}};
  await saveRepoIntegration(io,{machine:null,repoRoot:'/repos/client-portal',source:'jira',connection:connection(),selection:{project:'OPS'}});const next=(await readConfig(io)).value;
  assert.equal(next.bindings[bindingKey(null,'/repos/client-portal')].jira.project,'OPS');assert.equal(next.bindings[bindingKey(null,'/repos/client-portal')].github.owner,'Acme');assert.equal(next.bindings[bindingKey('server','/srv/client-portal')].jira.connectionId,'personal');assert.deepEqual(next.connections,initial.connections);
  await assert.rejects(saveRepoIntegration(io,{machine:null,repoRoot:'/repos/client-portal',source:'jira',connection:{...connection(),auth:{kind:'bearer',tokenEnv:'OTHER_TOKEN'}},selection:{project:'WEB'}}),e=>e.code==='CONNECTION_CONFLICT');
  await assert.rejects(saveRepoIntegration(io,{machine:null,repoRoot:'/repos/client-portal',source:'jira',connection:{id:'server-cli',kind:'cli',site:'https://jira.example.net',execution:{machine:'server'}},selection:{project:'WEB'}}),e=>e.code==='UNSUPPORTED_INTEGRATION_HOST');
});
