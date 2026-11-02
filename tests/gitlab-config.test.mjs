import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {bindingKey,configPath,gitlabProjectPath,newConfig,readConfig,resolveBinding,updateConfig,validateConfig} from '../src/shared/config.js';

const copy=value=>JSON.parse(JSON.stringify(value)),key=bindingKey(null,'/fixture/repo');
function configuration(){
  const config=newConfig();config.connections={
    jira:{id:'jira',kind:'api',site:'https://acme.atlassian.net',auth:{kind:'basic',usernameEnv:'JIRA_EMAIL',tokenEnv:'JIRA_TOKEN'}},
    github:{id:'github',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',credentialEnv:'GITHUB_TOKEN'},
    gitlab:{id:'gitlab',kind:'api',site:'https://gitlab.example.test',auth:{kind:'bearer',tokenEnv:'GITLAB_TOKEN'}}
  };config.bindings[key]={machine:null,repoRoot:'/fixture/repo',jira:{connectionId:'jira',project:'WEB',jql:'project = WEB AND status != Closed'},github:{connectionId:'github',owner:'Acme',repo:'Web',status:{labels:{todo:['todo'],inProgress:['doing'],done:['done']}}}};config.preferences.retained={value:'unchanged'};return config;
}
async function fixture(t){
  const root=await fs.mkdtemp('/private/tmp/mc-gitlab-config-'),config=configuration();let writes=0;
  const io={appHome:root,readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:directory=>fs.mkdir(directory,{recursive:true}),writeTextFile:async(file,text,expected)=>{writes++;if(await io.readTextFile(file)!==expected)throw Object.assign(Error('stale snapshot'),{code:'STALE'});await fs.writeFile(file,text);}};
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await io.ensureDirectory(path.dirname(configPath(io)));await fs.writeFile(configPath(io),JSON.stringify(config,null,2)+'\n');return {io,config,writes:()=>writes,raw:()=>fs.readFile(configPath(io),'utf8')};
}

test('project path grammar accepts declared length/depth boundaries without normalizing namespace spelling',()=>{
  for(const value of ['x','Group/Sub_Group/proj-1','a.b/c_d/project','a'.repeat(255),Array(21).fill('g').join('/'),Array(20).fill('g').join('/')+'/'+('p'.repeat(215))])assert.equal(gitlabProjectPath(value),value);
  for(const value of ['',null,{},'a'.repeat(256),Array(22).fill('g').join('/'),'../x','group//proj','.hidden','a.','group/proj/','/group/proj','a/../b','a/./b','a%2Fb','a\\b','a/b?x=1','a/b#x','a b','g/é','g/-'])assert.throws(()=>gitlabProjectPath(value),e=>e.code==='INVALID_CONFIG',String(value));
});

test('saving GitLab to a shared binding preserves exact Jira/GitHub objects, profiles and unrelated preferences',async t=>{
  const f=await fixture(t),jira=JSON.stringify(f.config.bindings[key].jira),github=JSON.stringify(f.config.bindings[key].github),connections=JSON.stringify(f.config.connections),selected={connectionId:'gitlab',projectPath:'Group/sub/project',status:{labels:{todo:['Ready'],inProgress:['Doing'],done:['Shipped']}}};
  const saved=await updateConfig(f.io,draft=>{draft.bindings[key].gitlab=selected;});assert.equal(saved.revision,1);assert.equal(JSON.stringify(saved.bindings[key].jira),jira);assert.equal(JSON.stringify(saved.bindings[key].github),github);assert.equal(JSON.stringify(saved.connections),connections);assert.deepEqual(saved.preferences,f.config.preferences);assert.deepEqual(resolveBinding(saved,{machine:null,repoRoot:'/fixture/repo'}).gitlab,selected);assert.deepEqual((await readConfig(f.io)).value,saved);assert.equal(f.writes(),1);assert.equal(f.config.bindings[key].gitlab,undefined);
});

test('invalid project paths, missing connections and extra GitLab fields cannot write or change existing bytes',async t=>{
  const f=await fixture(t),before=await f.raw();
  const bad=['../x','group//proj','.hidden','a.','a/b/',Array(22).fill('g').join('/'),'x'.repeat(256)].map(projectPath=>({connectionId:'gitlab',projectPath}));
  bad.push({connectionId:'missing',projectPath:'group/project'},{connectionId:'toString',projectPath:'group/project'},{connectionId:'gitlab'},{connectionId:'gitlab',projectPath:'group/project',other:true});
  for(const selected of bad){await assert.rejects(updateConfig(f.io,draft=>{draft.bindings[key].gitlab=selected;}),e=>e.code==='INVALID_CONFIG');assert.equal(await f.raw(),before);}assert.equal(f.writes(),0);
});

test('GitLab labels use bounded, case-insensitive disjoint groups and reject Projects or malformed mappings without writing',async t=>{
  const f=await fixture(t),before=await f.raw(),labels={todo:['Todo'],inProgress:['Doing'],done:['Done']};
  const bad=[{}, {project:{}}, {labels:{todo:[],done:[]}}, {labels:{...labels,extra:[]}}, {labels:{...labels,done:['TODO']}}, {labels:{...labels,todo:['Todo','TODO']}}, {labels:{...labels,todo:[' ']}}, {labels:{...labels,todo:['x\nlabel']}}, {labels:{...labels,todo:['x'.repeat(201)]}}, {labels:{...labels,todo:Array.from({length:101},(_,i)=>'label-'+i)}}];
  for(const status of bad){await assert.rejects(updateConfig(f.io,draft=>{draft.bindings[key].gitlab={connectionId:'gitlab',projectPath:'group/project',status};}),e=>e.code==='INVALID_CONFIG');assert.equal(await f.raw(),before);}assert.equal(f.writes(),0);
  const saved=await updateConfig(f.io,draft=>{draft.bindings[key].gitlab={connectionId:'gitlab',projectPath:'group/project',status:{labels:{todo:[],inProgress:['Doing'],done:[]}}};});assert.deepEqual(saved.bindings[key].gitlab.status.labels,{todo:[],inProgress:['Doing'],done:[]});
});

test('an invalid persisted GitLab binding is preserved instead of being silently repaired',async t=>{
  const f=await fixture(t),config=copy(f.config);config.bindings[key].gitlab={connectionId:'gitlab',projectPath:'group//project'};const before=JSON.stringify(config,null,2)+'\n';await fs.writeFile(configPath(f.io),before);let edited=false;await assert.rejects(updateConfig(f.io,()=>{edited=true;}),e=>e.code==='INVALID_CONFIG');assert.equal(edited,false);assert.equal(f.writes(),0);assert.equal(await f.raw(),before);
});

test('a CAS retry adding GitLab preserves a concurrent Jira filter change and other-machine bindings',async t=>{
  const f=await fixture(t),remoteKey=bindingKey('server','/fixture/repo'),write=f.io.writeTextFile;let raced=false;
  f.io.writeTextFile=async(file,text,expected)=>{if(!raced){raced=true;const concurrent=JSON.parse(await f.raw());concurrent.bindings[key].jira.jql='project = WEB AND assignee = currentUser()';concurrent.bindings[remoteKey]={machine:'server',repoRoot:'/fixture/repo',gitlab:{connectionId:'gitlab',projectPath:'remote/team/project'}};concurrent.revision++;await fs.writeFile(file,JSON.stringify(concurrent,null,2)+'\n');}return write(file,text,expected);};
  const saved=await updateConfig(f.io,draft=>{draft.bindings[key].gitlab={connectionId:'gitlab',projectPath:'local/team/project'};});assert.equal(saved.revision,2);assert.equal(saved.bindings[key].jira.jql,'project = WEB AND assignee = currentUser()');assert.deepEqual(saved.bindings[key].github,f.config.bindings[key].github);assert.equal(resolveBinding(saved,{machine:'server',repoRoot:'/fixture/repo'}).gitlab.projectPath,'remote/team/project');assert.equal(resolveBinding(saved,{machine:null,repoRoot:'/fixture/repo'}).gitlab.projectPath,'local/team/project');assert.equal(f.writes(),2);assert.doesNotThrow(()=>validateConfig(saved));
});
