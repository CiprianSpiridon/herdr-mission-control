import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {githubEndpoints,validateGithubConnection,resolveGithubAuth} from '../src/mods/mission-control-github/auth.mjs';
import {publicTrackerError,requestJson} from '../src/shared/tracker-transport.mjs';

const profile=(id='work',site='https://github.com')=>({id,kind:'github',site,apiBase:githubEndpoints(site).apiBase,credentialEnv:'WORK_TOKEN'});
const selected=(site,account,id='work')=>{const c=profile(id,site);delete c.credentialEnv;return {...c,gh:{host:new URL(site).host,account}};};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fakeGh(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-github-auth-')),command=path.join(root,'gh'),config=path.join(root,'fixture.json'),trace=path.join(root,'calls.jsonl'),store=path.join(root,'hosts.yml');
  const initial='fixture-active-account: do-not-change\n';await fs.writeFile(store,initial);
  const state={modern:true,user:true,hostname:true,mode:'ok',accounts:{}};await fs.writeFile(config,JSON.stringify(state));
  await fs.writeFile(command,`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const root=process.env.FIXTURE_GH_ROOT,state=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8')),args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({args,pid:process.pid,ambient:['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_DEBUG','DEBUG','GH_REPO'].filter(key=>Object.hasOwn(process.env,key)),host:process.env.GH_HOST,prompt:process.env.GH_PROMPT_DISABLED,updates:process.env.GH_NO_UPDATE_NOTIFIER})+'\\n');
const help=args.join(' ')==='auth token --help';
if(help&&state.mode==='slow-help')await new Promise(resolve=>setTimeout(resolve,60000));
if(help){
 if(state.mode==='help-fail'){process.stderr.write('PRIVATE fixture-token');process.exit(1);}
 process.stdout.write('Usage: gh auth token [flags]\\n'+(state.hostname?'  -h, --hostname string\\n':'')+(state.user?'  -u, --user string\\n':'')+(state.modern?'      --no-refresh\\n':'')+(state.refreshWarning?'Expired credentials are refreshed automatically.\\n':''));process.exit(0);
}
if(args[0]!=='auth'||args[1]!=='token'||!args.includes('--hostname')||!args.includes('--user')){process.stderr.write('Forbidden fixture command');process.exit(2);}
if(state.modern&&!args.includes('--no-refresh'))fs.writeFileSync(path.join(root,'hosts.yml'),'unexpected refresh');
const host=args[args.indexOf('--hostname')+1],account=args[args.indexOf('--user')+1],value=state.accounts[host+'/'+account];
if(state.mode==='slow')await new Promise(resolve=>setTimeout(resolve,60000));
if(state.mode==='fail'||!value){process.stderr.write('PRIVATE fixture-token credential-store error');process.exit(1);}
if(state.mode==='large'){await new Promise(resolve=>process.stdout.write('x'.repeat(65537),resolve));process.exit(0);}
if(state.mode==='large-stderr'){await new Promise(resolve=>process.stderr.write('x'.repeat(65537),resolve));process.exit(0);}
if(state.mode==='utf8'){process.stdout.write(Buffer.from([255]));process.exit(0);}
process.stdout.write(state.mode==='blank'?'\\n':state.mode==='multiline'?value+'\\nsecond-token\\n':value+'\\n');
`);await fs.chmod(command,0o700);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const env={...process.env,FIXTURE_GH_ROOT:root,GH_CONFIG_DIR:root};
  // Account/store assertions use the supported whole-lookup budget, independent
  // of Node fixture startup latency. Explicit deadline/cancel cases are below.
  return {command,state,store,initial,env,options:{env,ghCommand:command,timeoutMs:25000},
    configure:async change=>{Object.assign(state,change);await fs.writeFile(config,JSON.stringify(state));},
    calls:async()=>{try{return (await fs.readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){if(e.code==='ENOENT')return [];throw e;}}};
}

async function endpoint(t,{token='fixture-work',repo='acme/client'}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gh-tls-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],state={redirect:null};
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{
    requests.push({url:req.url,authorization:req.headers.authorization,version:req.headers['x-github-api-version']});
    if(state.redirect){res.writeHead(302,{location:state.redirect});res.end();return;}
    res.setHeader('content-type','application/json');res.writeHead(req.headers.authorization==='Bearer '+token?200:401);res.end(JSON.stringify({repo}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const origin='https://127.0.0.1:'+server.address().port;return {origin,ca,requests,state};
}

test('GitHub.com, data-residency cloud and Enterprise Server require matching explicit API bases',()=>{
  assert.equal(githubEndpoints('https://github.com/').apiBase,'https://api.github.com');
  assert.equal(githubEndpoints('https://acme.ghe.com').graphqlUrl,'https://api.acme.ghe.com/graphql');
  assert.equal(githubEndpoints('https://git.acme.invalid:8443').graphqlUrl,'https://git.acme.invalid:8443/api/graphql');
  assert.equal(validateGithubConnection(profile()).kind,'github');
  assert.equal(validateGithubConnection(selected('https://git.acme.invalid','alice')).gh.host,'git.acme.invalid');
  const bad=[{...profile(),apiBase:'https://elsewhere.invalid'},{...profile(),apiBase:'https://api.github.com/private'},{...profile(),apiBase:'https://api.github.com?token=PRIVATE'},{...profile(),kind:'api'},{...profile(),credentialEnv:'literal token'},
    {...profile(),gh:{host:'github.com',account:'alice'}},{...selected('https://github.com','alice'),gh:{host:'different.invalid',account:'alice'}},
    {...selected('https://github.com','alice'),gh:{host:'github.com',account:'--another-account'}},
    {...profile(),token:'PRIVATE'},{...profile(),extra:true}];
  const absent=profile();delete absent.credentialEnv;bad.push(absent);
  for(const c of bad)assert.throws(()=>validateGithubConnection(c));
  for(const site of ['http://github.com','https://user:PRIVATE@github.com','https://github.com/path','https://api.github.com','https://api.acme.ghe.com','https://ghe.com'])assert.throws(()=>githubEndpoints(site));
});

test('invalid host/account profiles fail before any credential command runs',async t=>{
  const gh=await fakeGh(t),c=selected('https://github.com','alice');
  for(const bad of [{...c,apiBase:'https://wrong.invalid'},{...c,gh:{...c.gh,account:''}},{...c,gh:{...c.gh,host:'wrong.invalid'}}])await assert.rejects(resolveGithubAuth(bad,gh.options));
  assert.deepEqual(await gh.calls(),[]);assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
});

test('two selected gh accounts fetch their own HTTPS repositories without ambient overrides or global switching',async t=>{
  const gh=await fakeGh(t),a=await endpoint(t,{token:'fixture-alice',repo:'work/web'}),b=await endpoint(t,{token:'fixture-bob',repo:'personal/tools'});
  await gh.configure({accounts:{[new URL(a.origin).host+'/alice']:'fixture-alice',[new URL(b.origin).host+'/bob']:'fixture-bob'}});
  const env={...gh.env,GH_TOKEN:'ambient-wrong',GITHUB_TOKEN:'ambient-wrong',GH_ENTERPRISE_TOKEN:'ambient-wrong',GITHUB_ENTERPRISE_TOKEN:'ambient-wrong',GH_DEBUG:'api',DEBUG:'*',GH_REPO:'wrong/repo'},before={...env};
  const sessions=await Promise.all([resolveGithubAuth(selected(a.origin,'alice','work'),{env,ghCommand:gh.command,timeoutMs:25000}),resolveGithubAuth(selected(b.origin,'bob','personal'),{env,ghCommand:gh.command,timeoutMs:25000})]);
  const values=await Promise.all(sessions.map((session,i)=>requestJson(session.connection.apiBase+'/repos/selected',{allowedOrigin:session.allowedOrigin,headers:session.headers,ca:[a,b][i].ca})));
  assert.deepEqual(values,[{repo:'work/web'},{repo:'personal/tools'}]);assert.deepEqual(env,before);assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
  assert.equal(a.requests[0].authorization,'Bearer fixture-alice');assert.equal(b.requests[0].authorization,'Bearer fixture-bob');assert.equal(a.requests[0].version,'2022-11-28');
  const calls=await gh.calls();assert.equal(calls.length,4);assert.ok(calls.every(call=>!call.ambient.length&&call.prompt==='1'&&call.updates==='1'));
  assert.ok(calls.filter(call=>!call.args.includes('--help')).every(call=>call.args.includes('--no-refresh')&&call.args.includes('--user')&&call.args.includes('--hostname')));
  assert.doesNotMatch(JSON.stringify(calls),/fixture-alice|fixture-bob|ambient-wrong/);assert.doesNotMatch(JSON.stringify(sessions),/fixture-alice|fixture-bob|authorization/);
});

test('explicit environment references bypass gh and cannot forward credentials to another origin',async t=>{
  const a=await endpoint(t),sink=await endpoint(t),env={WORK_TOKEN:'fixture-work'},session=await resolveGithubAuth(profile('work',a.origin),{env,ghCommand:'/missing/uninvoked-gh'});
  assert.deepEqual(await requestJson(session.connection.apiBase+'/repos/work',{allowedOrigin:session.allowedOrigin,headers:session.headers,ca:a.ca}),{repo:'acme/client'});
  a.state.redirect=sink.origin+'/capture';await assert.rejects(requestJson(session.connection.apiBase+'/redirect',{allowedOrigin:session.allowedOrigin,headers:session.headers,ca:a.ca}),e=>e.code==='UNTRUSTED_ORIGIN');assert.equal(sink.requests.length,0);
  assert.equal(env.WORK_TOKEN,'fixture-work');assert.doesNotMatch(JSON.stringify(session),/fixture-work|authorization/);
  for(const value of [undefined,'','bad\r\nheader','padded token','non-ascii-é'])await assert.rejects(resolveGithubAuth(profile(),{env:{WORK_TOKEN:value}}),e=>e.code==='AUTH_REQUIRED');
});

test('legacy gh account flags remain supported and newer token lookup disables automatic refresh',async t=>{
  const gh=await fakeGh(t),input=selected('https://github.com','alice');await gh.configure({modern:false,accounts:{'github.com/alice':'fixture-legacy'}});
  const result=await resolveGithubAuth(input,gh.options);assert.equal(result.headers.authorization,'Bearer fixture-legacy');
  const calls=await gh.calls();assert.equal(calls.length,2);assert.equal(calls[1].args.includes('--no-refresh'),false);assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
});

test('missing account flags and refresh behavior without a disable flag stop after help',async t=>{
  const gh=await fakeGh(t),input=selected('https://github.com','alice');
  for(const change of [{user:false},{user:true,hostname:false},{hostname:true,modern:false,refreshWarning:true},{mode:'help-fail'}]){
    await gh.configure(change);const before=(await gh.calls()).length;
    await assert.rejects(resolveGithubAuth(input,gh.options),e=>e.code==='ACCOUNT_SELECTION_UNSUPPORTED');
    assert.equal((await gh.calls()).length,before+1);
  }
  assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
});

test('missing credentials and malformed, failed or oversized CLI output produce only static errors',async t=>{
  const gh=await fakeGh(t),input=selected('https://github.com','alice');await gh.configure({accounts:{'github.com/alice':'fixture-private-token'}});
  for(const [mode,code]of [['fail','AUTH_REQUIRED'],['blank','AUTH_REQUIRED'],['multiline','AUTH_REQUIRED'],['utf8','AUTH_REQUIRED'],['large','RESPONSE_TOO_LARGE'],['large-stderr','RESPONSE_TOO_LARGE']]){
    await gh.configure({mode});await assert.rejects(resolveGithubAuth(input,gh.options),e=>{assert.equal(e.code,code);assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE|fixture-private-token|credential-store/);return true;});
  }
  await gh.configure({mode:'ok',accounts:{}});await assert.rejects(resolveGithubAuth(input,gh.options),e=>e.code==='AUTH_REQUIRED');
  await assert.rejects(resolveGithubAuth(input,{env:gh.env,ghCommand:path.join(path.dirname(gh.command),'missing-gh')}),e=>e.code==='CLI_UNAVAILABLE');
  assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
});

test('deadline terminates the exact owned gh process and preserves credential-store bytes',async t=>{
  const gh=await fakeGh(t),input=selected('https://github.com','alice');await gh.configure({mode:'slow-help',accounts:{'github.com/alice':'fixture-token'}});
  await assert.rejects(resolveGithubAuth(input,{env:gh.env,ghCommand:gh.command,timeoutMs:5000}),e=>e.code==='REQUEST_TIMEOUT');
  const calls=await gh.calls();assert.equal(calls.length,1);const call=calls[0];assert.ok(call.args.includes('--help'),'The owned help process started');assert.throws(()=>process.kill(call.pid,0),e=>e.code==='ESRCH');assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
});

test('cancellation closes a running selected-account process; pre-cancelled work never spawns',async t=>{
  const gh=await fakeGh(t),input=selected('https://github.com','alice'),pre=new AbortController();pre.abort();
  await assert.rejects(resolveGithubAuth(input,{env:gh.env,ghCommand:gh.command,signal:pre.signal}),e=>e.code==='REQUEST_CANCELLED');assert.deepEqual(await gh.calls(),[]);
  await gh.configure({mode:'slow',accounts:{'github.com/alice':'fixture-token'}});const abort=new AbortController(),pending=resolveGithubAuth(input,{env:gh.env,ghCommand:gh.command,signal:abort.signal,timeoutMs:25000}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');let call;
  try{const deadline=Date.now()+20000;while(Date.now()<deadline){call=(await gh.calls()).find(call=>!call.args.includes('--help'));if(call)break;await sleep(10);}}
  finally{abort.abort();await rejected;}
  assert.ok(call,'The selected token process acknowledged its owned PID');assert.throws(()=>process.kill(call.pid,0),e=>e.code==='ESRCH');assert.equal(await fs.readFile(gh.store,'utf8'),gh.initial);
});
