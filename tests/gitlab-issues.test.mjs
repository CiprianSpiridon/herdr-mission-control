import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fetchGitlabIssues,probeGitlabApi,gitlabProgressHint,gitlabReadContext} from '../src/mods/mission-control-gitlab/issues.mjs';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';

const NOW=1800000000000,copy=value=>JSON.parse(JSON.stringify(value));
const safeError=code=>error=>{assert.equal(error.code,code);assert.doesNotMatch(error.stack+JSON.stringify(publicTrackerError(error)),/fixture-private-token|PRIVATE_PROVIDER_BODY|PRIVATE_CREDENTIAL/);return true;};
const decode=value=>JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
const encode=value=>Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-issues-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],projectPath='Group/web/client',projectId='9007199254740993';
  const state={projectId,projectPath,enabled:true,pages:new Map(),now:NOW,advance:null,status:200,failPage:null,delay:0,active:0,peak:0};
  let origin;
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{
    const url=new URL(req.url,origin),page=Number(url.searchParams.get('page')||1);requests.push({url:req.url,method:req.method,authorization:req.headers.authorization});
    state.active++;state.peak=Math.max(state.peak,state.active);state.onRequest?.();res.once('close',()=>state.active--);
    const send=()=>{
      if(res.destroyed)return;
      if(req.headers.authorization!=='Bearer fixture-private-token'){res.writeHead(401);res.end('PRIVATE_PROVIDER_BODY');return;}
      if(state.status!==200||page===state.failPage){res.writeHead(page===state.failPage?429:state.status,{'retry-after':'2'});res.end('PRIVATE_PROVIDER_BODY fixture-private-token');return;}
      if(url.pathname==='/api/v4/projects/'+encodeURIComponent(projectPath)){
        res.setHeader('content-type','application/json');res.end(JSON.stringify({id:state.projectId,path_with_namespace:state.projectPath,web_url:origin+'/'+state.projectPath,issues_enabled:state.enabled}));return;
      }
      if(url.pathname!=='/api/v4/projects/'+encodeURIComponent(projectPath)+'/issues'){res.writeHead(404);res.end();return;}
      const response=state.pages.get(page)||{rows:[],next:null};
      if(response.next!==undefined)res.setHeader('x-next-page',response.next===null?'':String(response.next));
      if(response.headers)for(const [key,value]of Object.entries(response.headers))res.setHeader(key,value);
      if(state.advance?.page===page){state.now+=state.advance.ms;state.advance=null;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(response.rows));
    };
    if(state.delay)setTimeout(send,state.delay);else send();
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  const connection={id:'gl-work',kind:'api',site:origin,auth:{kind:'bearer',tokenEnv:'GL_TOKEN'}};
  const binding={machine:'server',repoRoot:'/srv/client',gitlab:{connectionId:connection.id,projectPath}};
  const request={v:1,operation:'issues',connection,binding},options={ca,env:{GL_TOKEN:'fixture-private-token'},clock:()=>state.now};
  const issue=(iid,change={})=>({id:String(BigInt(projectId)+BigInt(iid)),iid,project_id:projectId,issue_type:'issue',state:'opened',title:'Fix issue '+iid,description:'Issue details',labels:[],updated_at:new Date(NOW).toISOString(),web_url:origin+'/'+projectPath+'/-/issues/'+iid,...change});
  return {origin,state,requests,request,options,issue};
}

test('real HTTPS project probe and issue pages preserve nested paths, global IDs and To do/Done defaults',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await probeGitlabApi({...f.request,operation:'probe'},f.options),{site:f.origin,projectId:f.state.projectId,projectPath:f.state.projectPath,issuesEnabled:true});
  f.state.pages.set(1,{rows:[f.issue(42),f.issue(43,{state:'closed'})],next:2});
  f.state.pages.set(2,{rows:[f.issue(44)],next:null});
  const result=await fetchGitlabIssues(f.request,f.options);
  assert.deepEqual(result.data.map(row=>[row.key,row.statusGroup]),[['GL-42','todo'],['GL-43','done'],['GL-44','todo']]);
  assert.equal(result.data[0].identity.id,f.issue(42).id);assert.notEqual(result.data[0].identity.id,'42');assert.equal(result.data[0].repoBinding.machine,'server');
  assert.equal(result.data[0].url,f.origin+'/Group/web/client/-/issues/42');assert.equal(result.truncated,false);assert.equal(result.cursor,undefined);
  const pages=f.requests.filter(r=>r.url.includes('/issues?'));assert.equal(pages.length,2);
  for(const [i,r]of pages.entries()){
    const url=new URL(r.url,f.origin);assert.equal(url.pathname,'/api/v4/projects/Group%2Fweb%2Fclient/issues');
    assert.deepEqual(Object.fromEntries(url.searchParams),{state:'all',issue_type:'issue',per_page:'50',order_by:'updated_at',sort:'desc',page:String(i+1)});
    assert.equal(r.method,'GET');assert.equal(r.authorization,'Bearer fixture-private-token');
  }
  assert.match(gitlabProgressHint(f.request.binding),/Configure In progress labels/);
});

test('workflow labels match case-insensitively, closed wins, and an ambiguous issue is excluded with a scoped error',async t=>{
  const f=await fixture(t),request=copy(f.request);
  request.binding.gitlab.status={labels:{todo:['Ready'],inProgress:['Doing'],done:['Shipped']}};
  f.state.pages.set(1,{rows:[f.issue(1,{labels:['READY']}),f.issue(2,{labels:['doing']}),f.issue(3,{state:'closed',labels:['Doing','Shipped']}),f.issue(4,{labels:['unmapped']}),f.issue(5,{labels:['Doing','Shipped']})],next:null});
  const result=await fetchGitlabIssues(request,f.options);
  assert.deepEqual(result.data.map(row=>[row.key,row.statusGroup,row.statusName]),[['GL-1','todo','READY'],['GL-2','inProgress','doing'],['GL-3','done','Closed'],['GL-4','todo','Open']]);
  assert.equal(result.error.code,'STATUS_MAPPING_REQUIRED');assert.equal(result.truncated,false);assert.equal(gitlabProgressHint(request.binding),'');
  const invalid=copy(request);invalid.binding.gitlab.status.labels.todo.push('DOING');const before=f.requests.length;
  await assert.rejects(fetchGitlabIssues(invalid,f.options),safeError('STATUS_MAPPING_REQUIRED'));assert.equal(f.requests.length,before);
});

test('wrong projects, non-issue types, malformed source identities and duplicate iid ownership publish no snapshot',async t=>{
  const f=await fixture(t);
  f.state.projectPath='Group/other/client';await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError('INVALID_SCOPE'));
  assert.equal(f.requests.filter(r=>r.url.includes('/issues?')).length,0);f.state.projectPath='Group/web/client';
  const cases=[
    [{project_id:'44'},'INVALID_SCOPE'],[{web_url:f.origin+'/Group/other/client/-/issues/1'},'INVALID_SCOPE'],
    [{web_url:f.issue(1).web_url+'?token=PRIVATE_CREDENTIAL'},'INVALID_SCOPE'],
    ...['incident','task','test_case',null].map(issue_type=>[{issue_type},'INVALID_RESPONSE']),
    [{id:9007199254740992},'INVALID_RESPONSE'],[{iid:'01'},'INVALID_RESPONSE'],[{state:'unknown'},'INVALID_RESPONSE'],[{labels:[42]},'INVALID_RESPONSE'],[{updated_at:'bad-date'},'INVALID_RESPONSE'],
  ];
  for(const [change,code]of cases){f.state.pages.set(1,{rows:[f.issue(1,change)],next:null});await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError(code));}
  f.state.pages.set(1,{rows:[f.issue(1),f.issue(1,{id:'42'})],next:null});await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError('INVALID_SCOPE'));
  f.state.pages.set(1,{rows:[f.issue(1),f.issue(2,{id:f.issue(1).id})],next:null});await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError('INVALID_SCOPE'));
  f.state.enabled=false;await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError('NOT_FOUND'));
});

test('deadline continuation resumes the next page and rejects cross-account, host, repo, selection or credential scope',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.issue(1),f.issue(2)],next:2});f.state.pages.set(2,{rows:[f.issue(3)],next:null});f.state.advance={page:1,ms:24000};
  const first=await fetchGitlabIssues(f.request,f.options);assert.equal(first.truncated,true);assert.equal(decode(first.cursor).page,2);assert.equal(decode(first.cursor).count,2);
  const resume={...f.request,cursor:first.cursor},before=f.requests.length;
  const changed=[
    {...resume,binding:{...resume.binding,machine:'other-server'}},
    {...resume,binding:{...resume.binding,repoRoot:'/srv/other'}},
    {...resume,binding:{...resume.binding,gitlab:{...resume.binding.gitlab,projectPath:'Group/other/client'}}},
    {...resume,connection:{...resume.connection,site:'https://other.invalid'}},
    {...resume,connection:{...resume.connection,auth:{kind:'bearer',tokenEnv:'OTHER_TOKEN'}}},
    {...resume,connection:{...resume.connection,id:'personal'},binding:{...resume.binding,gitlab:{...resume.binding.gitlab,connectionId:'personal'}}},
  ];
  for(const request of changed)await assert.rejects(fetchGitlabIssues(request,f.options),safeError('INVALID_SCOPE'));
  const raw=decode(first.cursor);
  for(const change of [{page:0},{count:1000},{seen:['bad']},{issuedAt:f.state.now+6000},{extra:true}])await assert.rejects(fetchGitlabIssues({...resume,cursor:encode({...raw,...change})},f.options),safeError('INVALID_SCOPE'));
  assert.equal(f.requests.length,before);
  f.state.projectId='44';await assert.rejects(fetchGitlabIssues(resume,f.options),safeError('INVALID_SCOPE'));assert.equal(f.requests.length,before+1);f.state.projectId=raw.projectId;
  const next=await fetchGitlabIssues(resume,f.options);assert.deepEqual(next.data.map(row=>row.key),['GL-3']);assert.equal(next.truncated,false);
  const last=new URL(f.requests.at(-1).url,f.origin);assert.equal(last.searchParams.get('page'),'2');
  f.state.now=raw.issuedAt+7*86400000;const expiredCount=f.requests.length;await assert.rejects(fetchGitlabIssues(resume,f.options),safeError('INVALID_SCOPE'));assert.equal(f.requests.length,expiredCount);
});

test('rate limits and repeated pages cannot publish partial cards; missing metadata stays explicit',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.issue(1)],next:2});f.state.failPage=2;
  await assert.rejects(fetchGitlabIssues(f.request,f.options),error=>{safeError('RATE_LIMITED')(error);assert.equal(error.status,429);assert.equal(error.retryAfterMs,2000);return true;});
  f.state.failPage=null;f.state.pages.set(2,{rows:[f.issue(1)],next:3});await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError('INVALID_SCOPE'));
  f.state.pages.set(1,{rows:Array.from({length:50},(_,i)=>f.issue(i+1))});await assert.rejects(fetchGitlabIssues(f.request,f.options),safeError('INCOMPLETE_RESULTS'));
  f.state.pages.set(1,{rows:[f.issue(1)]});assert.equal((await fetchGitlabIssues(f.request,f.options)).truncated,false);
  const abort=new AbortController();abort.abort();const before=f.requests.length;await assert.rejects(fetchGitlabIssues(f.request,{...f.options,signal:abort.signal}),safeError('REQUEST_CANCELLED'));assert.equal(f.requests.length,before);
});

test('the 1000-record cap distinguishes a complete last page from further results and bounds resumed counts',async t=>{
  const f=await fixture(t);
  for(let page=1;page<=20;page++)f.state.pages.set(page,{rows:Array.from({length:50},(_,i)=>f.issue((page-1)*50+i+1)),next:page===20?null:page+1});
  const complete=await fetchGitlabIssues(f.request,f.options);assert.equal(complete.data.length,1000);assert.equal(complete.truncated,false);
  f.state.pages.get(20).next=21;const before=f.requests.length;
  const capped=await fetchGitlabIssues(f.request,f.options);assert.equal(capped.data.length,1000);assert.equal(capped.truncated,true);assert.equal(capped.error.code,'RESPONSE_TOO_LARGE');assert.equal(capped.cursor,undefined);assert.equal(f.requests.length,before+21);
  f.state.pages.set(20,{rows:Array.from({length:35},(_,i)=>f.issue(951+i)),next:21});f.state.advance={page:20,ms:24000};
  const partial=await fetchGitlabIssues(f.request,f.options);assert.equal(decode(partial.cursor).count,985);
  f.state.pages.set(21,{rows:Array.from({length:50},(_,i)=>f.issue(986+i)),next:null});
  const remainder=await fetchGitlabIssues({...f.request,cursor:partial.cursor},f.options);
  assert.equal(remainder.data.length,15);assert.equal(remainder.data.at(-1).key,'GL-1000');assert.equal(remainder.truncated,true);assert.equal(remainder.cursor,undefined);assert.equal(remainder.error.code,'RESPONSE_TOO_LARGE');
});

test('hostile descriptions remain bounded plain text and output exhaustion resumes a whole unconsumed page',async t=>{
  const f=await fixture(t),hostile='$(touch /tmp/not-executed) `command` <script>text only</script>\u0001\n';
  f.state.pages.set(1,{rows:[f.issue(1,{title:'$(command) remains an issue title',description:hostile+'🙂'.repeat(20000)})],next:null});
  const row=(await fetchGitlabIssues(f.request,f.options)).data[0];assert.match(row.body,/\\u0001/);assert.match(row.body,/description truncated/);assert.ok(Buffer.byteLength(row.body)<64000);assert.equal(row.title,'$(command) remains an issue title');assert.doesNotMatch(row.body,/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  for(let page=1;page<=5;page++)f.state.pages.set(page,{rows:Array.from({length:50},(_,i)=>f.issue((page-1)*50+i+1,{description:'a'.repeat(48000)})),next:page===5?null:page+1});
  const first=await fetchGitlabIssues(f.request,f.options);assert.equal(first.data.length,150);assert.ok(Buffer.byteLength(JSON.stringify(first))<8*1024*1024);assert.equal(first.error.code,'RESPONSE_TOO_LARGE');assert.equal(decode(first.cursor).page,4);assert.equal(decode(first.cursor).count,150);
  const next=await fetchGitlabIssues({...f.request,cursor:first.cursor},f.options);assert.equal(next.data[0].key,'GL-151');assert.equal(next.data.length,100);assert.equal(next.truncated,false);
  assert.ok(f.requests.every(request=>request.method==='GET'));
});

test('one helper context limits concurrent HTTP reads to four and observes one shared deadline',async t=>{
  const f=await fixture(t);f.state.delay=15;
  const ctx=gitlabReadContext(f.options),auth=ctx.auth(f.request.connection),url=auth.apiBase+'/projects/'+encodeURIComponent(f.state.projectPath);
  try{const values=await Promise.all(Array.from({length:12},()=>ctx.call(auth,url)));assert.equal(values.length,12);assert.equal(f.state.peak,4);}finally{ctx.cancel();}
  const before=f.requests.length,expired=gitlabReadContext(f.options),expiredAuth=expired.auth(f.request.connection);f.state.now+=26000;
  try{await assert.rejects(expired.call(expiredAuth,url),safeError('REQUEST_TIMEOUT'));assert.equal(f.requests.length,before);}finally{expired.cancel();}
});

test('cancellation drains every queued reader without starting additional HTTP requests',async t=>{
  const f=await fixture(t);f.state.delay=100;
  let entered;const fourRequests=new Promise(resolve=>entered=resolve);f.state.onRequest=()=>{if(f.state.active===4)entered();};
  const ctx=gitlabReadContext(f.options),auth=ctx.auth(f.request.connection),url=auth.apiBase+'/projects/'+encodeURIComponent(f.state.projectPath);
  const settled=Promise.allSettled(Array.from({length:12},()=>ctx.call(auth,url)));
  try{
    await fourRequests;ctx.cancel();const results=await settled;
    assert.equal(results.length,12);for(const result of results){assert.equal(result.status,'rejected');safeError('REQUEST_CANCELLED')(result.reason);}
    assert.equal(f.requests.length,4);
  }finally{ctx.cancel();}
});
