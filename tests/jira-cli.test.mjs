import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';
import {fetchJiraCli,probeJiraCli,jiraCliArgs} from '../src/mods/mission-control-jira/cli.mjs';

const NOW=1800000000000;
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-jira-cli-')),script=path.join(root,'bridge.mjs'),record=path.join(root,'argv.json');
  await fs.writeFile(script,`import fs from 'node:fs';
const args=process.argv.slice(2),mode=args[0],request=JSON.parse(args[1]);
fs.writeFileSync(args[2],JSON.stringify({args,request,pid:process.pid,cwd:process.cwd()}));
if(mode==='exit'){process.stderr.write('PRIVATE credential /private/auth.json');process.exit(2);}
if(mode==='invalid'){process.stdout.write('not JSON');process.exit(0);}
if(mode==='utf8'){process.stdout.write(Buffer.from([255]));process.exit(0);}
if(mode==='huge'){await new Promise(r=>process.stdout.write('x'.repeat(4194305),r));process.exit(0);}
if(mode==='stderr'){await new Promise(r=>process.stderr.write('x'.repeat(65537),r));process.exit(0);}
if(mode==='slow'){await new Promise(r=>setTimeout(r,60000));}
const issue=(n,status)=>({id:10000+n,key:'WEB-'+n,title:'Fix login '+n,body:'Task data',status,priority:'High',updated:'2026-10-30T10:00:00Z'});
const profile=args[3],second=request.cursor==='page-two',items=mode==='empty'?[]:mode==='unknown'?[issue(142,'Unknown')]:second?[issue(143,'Doing'),issue(144,'Done')]:[issue(142,'Open')];
if(mode==='url')items[0].url='https://other.atlassian.net/browse/WEB-142';
const output={items,profile,next:mode==='repeat'?'repeat':mode==='single'||mode==='empty'||second?null:'page-two'};
if(mode==='missing-next')delete output.next;
if(mode==='many'||mode==='many-large'||mode==='too-many'){const page=Number(request.cursor||0);output.items=Array.from({length:mode==='too-many'?51:50},(_,i)=>issue(page*50+i+1,i%3===0?'Done':'Open'));output.next=String(page+1);if(mode==='many-large')for(const item of output.items)item.body='x'.repeat(48000);}
process.stdout.write(JSON.stringify(output));
`);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const connection=(mode='pages',id='work',site='https://work.atlassian.net')=>({id,kind:'cli',site,execution:{machine:null,command:process.execPath,argsTemplate:[script,mode,'{{request}}',record,'{{connectionId}}']},mapping:{issuesPath:'items',nextCursorPath:'next',fields:{id:'id',key:'key',title:'title',body:'body',status:'status',priority:'priority',updatedAt:'updated'},statusGroups:{todo:['Open'],inProgress:['Doing'],done:['Done']}}});
  return {root,script,record,connection,read:async()=>JSON.parse(await fs.readFile(record,'utf8'))};
}
const request=c=>({v:1,operation:'issues',connection:c,binding:{machine:'remote-server',repoRoot:'/srv/client-portal',jira:{connectionId:c.id,project:'WEB'}}});
const options={clock:()=>NOW};

test('real local CLI paginates JSON/status mappings while work retains its separate remote repo host',async t=>{
  const f=await fixture(t),input=request(f.connection()),result=await fetchJiraCli(input,options);
  assert.equal(result.truncated,false);assert.deepEqual(result.data.map(v=>v.statusGroup),['todo','inProgress','done']);assert.equal(result.data[0].url,input.connection.site+'/browse/WEB-142');assert.equal(result.data[0].identity.id,'10142');assert.equal(result.data[0].repoBinding.machine,'remote-server');assert.equal(result.fetchedAt,NOW);
  const called=await f.read();assert.equal(called.request.cursor,'page-two');assert.equal(called.request.binding.machine,'remote-server');assert.equal(called.request.connection.execution.machine,null);assert.notEqual(called.cwd,'/srv/client-portal');
  assert.deepEqual(await probeJiraCli({...input,operation:'probe'},options),{site:input.connection.site,route:'local-cli'});
});

test('JQL and title shell metacharacters remain one data argument and cannot execute',async t=>{
  const f=await fixture(t),input=request(f.connection('single')),marker=path.join(f.root,'must-not-exist');input.binding.jira.jql='project = WEB; $(touch '+marker+') `touch '+marker+'` "quoted"';
  const result=await fetchJiraCli(input,options),called=await f.read();assert.equal(called.request.binding.jira.jql,input.binding.jira.jql);assert.equal(called.args.length,4);assert.equal(result.data.length,1);await assert.rejects(fs.access(marker));
  for(const argsTemplate of [[f.script,'single','prefix-{{jql}}'],[f.script,'single','{{unknown}}'],[f.script,'static-with-no-scope']])assert.throws(()=>jiraCliArgs({...input,connection:{...input.connection,execution:{...input.connection.execution,argsTemplate}}}),e=>e.code==='INVALID_CONNECTION');
  for(const execution of [{machine:null,command:'/bin/sh',argsTemplate:['-c','{{jql}}']},{machine:null,command:process.execPath,argsTemplate:['-e','{{jql}}']},{machine:'remote-server',command:process.execPath,argsTemplate:[]}])await assert.rejects(fetchJiraCli({...input,connection:{...input.connection,execution}},options),e=>['INVALID_CONNECTION','UNSUPPORTED_INTEGRATION_HOST'].includes(e.code));
});

test('connection profiles and same IDs across sites remain distinct without global CLI auth changes',async t=>{
  const f=await fixture(t),work=request(f.connection('single')),personal=request(f.connection('single','personal','https://personal.atlassian.net')),env={...process.env,JIRA_FIXTURE_SCOPE:'unchanged'},before={...env};
  const a=await fetchJiraCli(work,{...options,env}),b=await fetchJiraCli(personal,{...options,env});assert.deepEqual(env,before);assert.equal(a.data[0].identity.id,b.data[0].identity.id);assert.notEqual(a.data[0].identity.connectionId,b.data[0].identity.connectionId);assert.notEqual(a.data[0].url,b.data[0].url);assert.equal((await f.read()).args[3],'personal');
});

test('bounded CLI chunks reject wrong-scope and expired cursors before starting the program',async t=>{
  const f=await fixture(t),input=request(f.connection()),first=await fetchJiraCli(input,{...options,maxPages:1});assert.equal(first.truncated,true);assert.ok(first.cursor);
  const second=await fetchJiraCli({...input,cursor:first.cursor},options);assert.equal(second.truncated,false);assert.deepEqual(second.data.map(v=>v.key),['WEB-143','WEB-144']);const before=await fs.readFile(f.record,'utf8');
  for(const change of [{binding:{...input.binding,jira:{connectionId:'work',project:'OPS'}}},{connection:{...input.connection,site:'https://other.atlassian.net'}}])await assert.rejects(fetchJiraCli({...input,...change,cursor:first.cursor},options),e=>e.code==='INVALID_SCOPE');
  await assert.rejects(fetchJiraCli({...input,cursor:first.cursor},{clock:()=>NOW+7*86400000}),e=>e.code==='INVALID_SCOPE');assert.equal(await fs.readFile(f.record,'utf8'),before);
});

test('failed/malformed/unmapped CLI output has static errors and no plausible cards',async t=>{
  const f=await fixture(t);
  for(const [mode,code]of [['exit','ADAPTER_FAILED'],['invalid','INVALID_RESPONSE'],['utf8','INVALID_RESPONSE'],['huge','RESPONSE_TOO_LARGE'],['stderr','RESPONSE_TOO_LARGE'],['unknown','STATUS_MAPPING_REQUIRED'],['repeat','INVALID_SCOPE'],['missing-next','INVALID_RESPONSE']])await assert.rejects(fetchJiraCli(request(f.connection(mode)),options),e=>{assert.equal(e.code,code,mode);assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE|credential|auth\.json/);return true;});
  const c=f.connection('url');c.mapping.fields.url='url';await assert.rejects(fetchJiraCli(request(c),options),e=>e.code==='INVALID_RESPONSE');
  const empty=await fetchJiraCli(request(f.connection('empty')),options);assert.equal(empty.data.length,0);assert.equal(empty.truncated,false);
});

test('missing executable, unsafe JSON paths and ambiguous status mappings fail before spawn',async t=>{
  const f=await fixture(t),input=request(f.connection());
  await assert.rejects(fetchJiraCli({...input,connection:{...input.connection,execution:{...input.connection.execution,command:path.join(f.root,'missing-cli')}}},options),e=>e.code==='CLI_UNAVAILABLE');
  for(const mapping of [{...input.connection.mapping,issuesPath:'__proto__.items'},{...input.connection.mapping,fields:{...input.connection.mapping.fields,id:'constructor.name'}},{...input.connection.mapping,fields:{id:'id',key:'key'}},{...input.connection.mapping,statusGroups:{todo:['Open'],inProgress:['Open'],done:['Done']}}])await assert.rejects(fetchJiraCli({...input,connection:{...input.connection,mapping}},options),e=>['INVALID_CONNECTION','STATUS_MAPPING_REQUIRED'].includes(e.code));
  await assert.rejects(fs.access(f.record));
});

test('CLI setup probe rejects an invalid data-argument template without executing the program',async t=>{
  const f=await fixture(t),input=request(f.connection());input.operation='probe';input.connection.execution.argsTemplate=[f.script,'{{unknown}}'];await assert.rejects(probeJiraCli(input),e=>e.code==='INVALID_CONNECTION');await assert.rejects(fs.access(f.record));
});

test('CLI page/count/output-byte limits cannot silently discard or claim complete results',async t=>{
  const f=await fixture(t);await assert.rejects(fetchJiraCli(request(f.connection('too-many')),options),e=>e.code==='RESPONSE_TOO_LARGE');
  const capped=await fetchJiraCli(request(f.connection('many')),{...options,maxPages:20});assert.equal(capped.data.length,1000);assert.equal(capped.truncated,true);assert.equal(capped.cursor,undefined);assert.ok(capped.data.some(v=>v.statusGroup==='done'));
  const bounded=await fetchJiraCli(request(f.connection('many-large')),{...options,maxPages:20});assert.equal(bounded.truncated,true);assert.equal(bounded.error.code,'RESPONSE_TOO_LARGE');assert.equal(bounded.cursor,undefined);assert.ok(bounded.data.length>0&&bounded.data.length<1000);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<8*1024*1024);
});

test('timeout and cancellation stop the owned process without exposing stderr or changing auth',async t=>{
  const f=await fixture(t),input=request(f.connection('slow'));await assert.rejects(fetchJiraCli(input,{...options,timeoutMs:2000}),e=>e.code==='REQUEST_TIMEOUT');
  const timedOut=await f.read();await new Promise(resolve=>setTimeout(resolve,20));assert.throws(()=>process.kill(timedOut.pid,0),e=>e.code==='ESRCH');
  const abort=new AbortController(),pending=fetchJiraCli(input,{...options,signal:abort.signal}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');let cancelled;
  try{const deadline=Date.now()+3000;while(Date.now()<deadline){try{const current=await f.read();if(current.pid!==timedOut.pid){cancelled=current;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,10));}}
  finally{abort.abort();await rejected;}
  assert.ok(cancelled,'the cancelled process must prove its own PID before cancellation');await new Promise(resolve=>setTimeout(resolve,20));assert.throws(()=>process.kill(cancelled.pid,0),e=>e.code==='ESRCH');
});
