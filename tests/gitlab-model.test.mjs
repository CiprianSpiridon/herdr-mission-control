import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {newConfig,bindingKey,configPath,readConfig} from '../src/shared/config.js';
import {validateRepoBinding,trackerScope,validateTrackerScope,trackerScopeKey,selectTracker,allTrackerBindings,validateIssue,validateSnapshot,issueIdentityKey,aggregateIssues,ScopedTrackerCache,saveRepoIntegration} from '../src/shared/tracker-model.js';
import {IssueBoardState,renderIssueBoard,issueCardId} from '../src/shared/issue-board.js';
import {View,context,injectNative,findElement,trigger,renderRecorded} from './support/native-recording.mjs';

const NOW=1800000000000,copy=value=>JSON.parse(JSON.stringify(value));
const connection=(id='gl-work',site='https://git.example.test')=>({id,kind:'api',site,auth:{kind:'bearer',tokenEnv:id==='gl-work'?'GL_WORK_TOKEN':'GL_PERSONAL_TOKEN'}});
const binding=(id='gl-work',machine=null,repoRoot='/repos/app',projectPath='Group/sub/project')=>({machine,repoRoot,gitlab:{connectionId:id,projectPath,status:{labels:{todo:['Ready'],inProgress:['Doing'],done:['Done']}}}});
const issue=(c=connection(),b=binding(),number='42')=>({identity:{kind:'gitlab',connectionId:c.id,site:c.site,id:'9007199254740993'},key:'GL-'+number,title:'Restore request tracing',url:c.site+'/'+b.gitlab.projectPath+'/-/issues/'+number,body:'Task data.\nKeep this source.',statusGroup:'todo',statusName:'Opened',repoBinding:b,updatedAt:NOW-1000});
function sharedConfiguration(){
  const config=newConfig(),gl=connection(),b=binding();config.connections={
    [gl.id]:gl,'jira-work':{id:'jira-work',kind:'api',site:'https://acme.atlassian.net',auth:{kind:'basic',usernameEnv:'JIRA_USER',tokenEnv:'JIRA_TOKEN'}},
    'gh-work':{id:'gh-work',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',credentialEnv:'GH_WORK_TOKEN'}
  };b.jira={connectionId:'jira-work',project:'WEB'};b.github={connectionId:'gh-work',owner:'Acme',repo:'Web'};config.bindings[bindingKey(b.machine,b.repoRoot)]=b;return config;
}
function board(t,rows){
  injectNative({});const cx=context(),state=new IssueBoardState(),events=[],props={id:'gl-board',mod:'mission-control-gitlab',state,width:1000,now:NOW,view:{state:'ready',all:true,data:rows,bindings:[],errors:[],loading:0,truncated:false},preferences:{pins:['claude','codex','grok']},toolsForMachine:machine=>(machine?['grok']:['claude','codex']).map(key=>({key,name:key,run:['fixture-'+key],installed:true})),onOpenIssue:row=>events.push(['open',row]),onLaunch:(row,tool)=>events.push(['launch',row,tool]),onOptions:row=>events.push(['options',row]),onInvalid:message=>events.push(['invalid',message])};
  class Root extends View{render(cx){return renderIssueBoard(props,cx);}}
  const root=new Root();t.after(()=>state.close());return {cx,state,events,props,render:()=>renderRecorded(root,cx)};
}
async function storage(t,initial=sharedConfiguration()){
  const root=await fs.mkdtemp('/private/tmp/mc-gitlab-model-');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'mission-control'));const file=path.join(root,'mission-control/config.json');await fs.writeFile(file,JSON.stringify(initial,null,2)+'\n');let writes=0;
  const io={appHome:()=>root,readTextFile:file=>fs.readFile(file,'utf8'),writeTextFile:async(file,text,expected)=>{assert.equal(await fs.readFile(file,'utf8'),expected);writes++;await fs.writeFile(file,text);}};return {io,file,writes:()=>writes,raw:()=>fs.readFile(file,'utf8')};
}

test('GitLab scopes and nested bindings coexist with Jira and GitHub while preserving all five distinct source roles',()=>{
  const config=sharedConfiguration(),b=Object.values(config.bindings)[0],checked=validateRepoBinding(b);assert.deepEqual(checked,b);checked.gitlab.status.labels.todo.push('Added');assert.deepEqual(b.gitlab.status.labels.todo,['Ready']);
  const keys=[];for(const[source,id]of [['jira','jira-work'],['github','gh-work'],['github-pr','gh-work'],['gitlab','gl-work'],['gitlab-mr','gl-work']]){const selected=selectTracker(config,{state:'resolved',machine:null,repoRoot:b.repoRoot},source);assert.equal(selected.connection.id,id);assert.equal(selected.scope.source,source);assert.deepEqual(validateTrackerScope(selected.scope),selected.scope);assert.equal(allTrackerBindings(config,source).length,1);keys.push(trackerScopeKey(selected.scope));}assert.equal(new Set(keys).size,5);
  assert.equal(selectTracker(config,{state:'ambiguous',machine:null,repoRoot:b.repoRoot},'gitlab'),null);assert.throws(()=>trackerScope('invented',connection(),b),e=>e.code==='INVALID_SCOPE');assert.throws(()=>allTrackerBindings(newConfig(),'invented'),e=>e.code==='INVALID_SCOPE');
});

test('GitLab issue numbers are separate from decimal global identity and snapshots reject MR or changed project/account scopes',()=>{
  const c=connection(),b=binding(),s=trackerScope('gitlab',c,b),row=issue(c,b),snapshot={data:[row],fetchedAt:NOW,scope:s,truncated:false};assert.equal(validateIssue(row,{scope:s}).identity.id,'9007199254740993');assert.equal(validateSnapshot(snapshot,s,{now:NOW}).data[0].key,'GL-42');
  for(const other of [trackerScope('gitlab-mr',c,b),trackerScope('gitlab',c,{...b,gitlab:{...b.gitlab,projectPath:'other/project'}}),trackerScope('gitlab',connection('personal'),binding('personal')),trackerScope('gitlab',c,binding(c.id,'server'))])assert.throws(()=>validateSnapshot(snapshot,other,{now:NOW}));
  const scoped=trackerScope('gitlab',c,binding(c.id,null,b.repoRoot,Array(21).fill('g').join('/')));assert.equal(scoped.selection.projectPath.split('/').length,21);assert.throws(()=>trackerScope('gitlab',c,binding(c.id,null,b.repoRoot,Array(22).fill('g').join('/'))));
});

test('nested GitLab, existing Jira and existing GitHub cards each render source links and independently captured agent controls',async t=>{
  const config=sharedConfiguration(),b=Object.values(config.bindings)[0],gl=issue(config.connections['gl-work'],b),jira={...gl,identity:{kind:'jira',connectionId:'jira-work',site:'https://acme.atlassian.net',id:'10142'},key:'WEB-42',url:'https://acme.atlassian.net/browse/WEB-42'},github={...gl,identity:{kind:'github',connectionId:'gh-work',site:'https://github.com',id:'opaque-github-node'},key:'GH-42',url:'https://github.com/Acme/Web/issues/42'};
  for(const row of [gl,jira,github]){assert.doesNotThrow(()=>validateIssue(row));const f=board(t,[row]),id=issueCardId('gl-board',row),tree=f.render();await trigger(tree,id+'-key',undefined,{},f.cx);await trigger(tree,id+'-title',undefined,{},f.cx);await trigger(tree,id+'-start-codex',undefined,{},f.cx);await trigger(tree,id+'-options',undefined,{},f.cx);assert.deepEqual(f.events.map(e=>e[0]),['open','open','launch','options']);assert.equal(f.events[0][1].url,row.url);assert.equal(f.events[2][1].identity.kind,row.identity.kind);assert.equal(f.events[2][2],'codex');}
});

test('wrong GitLab URLs, iid/key pairs, global IDs, bindings and overlapping label groups cannot become launchable cards',t=>{
  const base=issue(),invalid=[];
  for(const mutate of [p=>p.url=p.url.replace('/-/issues/','/issues/'),p=>p.url=p.url.replace('/42','/43'),p=>p.key='GL-043',p=>p.key='GH-42',p=>p.identity.id='0',p=>p.identity.id='0123',p=>p.identity.id='opaque-id',p=>p.identity.kind='gitlab-mr',p=>p.identity.connectionId='other',p=>p.url+='?page=1',p=>p.url=p.url.replace('git.example.test','other.example.test'),p=>delete p.repoBinding.gitlab,p=>p.repoBinding.gitlab.projectPath='../project',p=>p.repoBinding.gitlab.status.labels.done=['ready']]){const row=copy(base);mutate(row);invalid.push(row);}
  for(const row of invalid){assert.throws(()=>validateIssue(row));const f=board(t,[row]),tree=f.render(),id=issueCardId('gl-board',row);for(const suffix of ['key','title','start-claude','start-codex','options'])assert.equal(findElement(tree,id+'-'+suffix).handlers.on_click,undefined);assert.equal(f.events.length,0);}
  const f=board(t,[copy(base)]),tree=f.render(),id=issueCardId('gl-board',base);f.props.view.data[0].repoBinding.gitlab.projectPath='changed/project';trigger(tree,id+'-key',undefined,{},f.cx);assert.deepEqual(f.events.map(e=>e[0]),['invalid'],'an already-rendered click still validates its actual source');
});

test('identical GitLab IDs on other accounts/sites/machines remain distinct and a late selection generation cannot publish',async t=>{
  const local=issue(),remote=issue(connection(),binding('gl-work','server')),personal=issue(connection('personal'),binding('personal')),otherSite=issue(connection('other','https://other.git.example.test'),binding('other'));
  assert.equal(new Set([local,remote,personal,otherSite].map(issueIdentityKey)).size,4);assert.equal(aggregateIssues([{data:[local,remote,personal,otherSite],truncated:false},{data:[local],truncated:false}]).data.length,4);
  const f=board(t,[local,remote,personal,otherSite]),tree=f.render(),id=issueCardId('gl-board',remote);await trigger(tree,id+'-start-grok',undefined,{},f.cx);assert.equal(f.events[0][1].repoBinding.machine,'server');assert.throws(()=>findElement(tree,id+'-start-claude'));
  const c=connection(),a=trackerScope('gitlab',c,local.repoBinding),b=trackerScope('gitlab',c,{...local.repoBinding,gitlab:{...local.repoBinding.gitlab,projectPath:'other/project'}}),cache=new ScopedTrackerCache({clock:()=>NOW});cache.accept(cache.begin(a),{data:[local],scope:a,fetchedAt:NOW,truncated:false});const held=cache.begin(a);cache.select(b);assert.equal(cache.snapshot,null);assert.equal(cache.accept(held,{data:[local],scope:a,fetchedAt:NOW,truncated:false}),false);assert.notEqual(trackerScopeKey(a),trackerScopeKey(trackerScope('gitlab',{...c,auth:{...c.auth,tokenEnv:'CHANGED_TOKEN'}},local.repoBinding)));
});

test('GitLab-only saves preserve existing provider objects and reject conflicting profiles or invalid changes without writes',async t=>{
  const initial=sharedConfiguration(),b=Object.values(initial.bindings)[0],f=await storage(t,initial),jira=JSON.stringify(b.jira),github=JSON.stringify(b.github),profiles=JSON.stringify(initial.connections);await saveRepoIntegration(f.io,{machine:b.machine,repoRoot:b.repoRoot,source:'gitlab',connection:connection(),selection:{projectPath:'new/sub/project',status:{labels:{todo:['Todo'],inProgress:['Active'],done:[]}}}});const saved=(await readConfig(f.io)).value,selected=saved.bindings[bindingKey(b.machine,b.repoRoot)];assert.equal(selected.gitlab.projectPath,'new/sub/project');assert.equal(JSON.stringify(selected.jira),jira);assert.equal(JSON.stringify(selected.github),github);assert.equal(JSON.stringify(saved.connections),profiles);assert.equal(f.writes(),1);
  const before=await f.raw();for(const request of [{source:'gitlab',connection:{...connection(),auth:{kind:'bearer',tokenEnv:'OTHER_TOKEN'}},selection:{projectPath:'new/sub/project'}},{source:'gitlab',connection:connection(),selection:{projectPath:'a//b'}},{source:'gitlab',connection:connection(),selection:{projectPath:'valid/project',status:{labels:{todo:['Todo'],inProgress:['TODO'],done:[]}}}},{source:'gitlab-mr',connection:connection(),selection:{projectPath:'valid/project'}}]){await assert.rejects(saveRepoIntegration(f.io,{machine:b.machine,repoRoot:b.repoRoot,...request}));assert.equal(await f.raw(),before);}assert.equal(f.writes(),1);
  assert.equal(configPath(f.io),f.file);
});
