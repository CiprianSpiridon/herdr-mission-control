import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gitlabEndpoints,validateGitlabConnection,resolveGitlabAuth,gitlabRequest} from '../src/mods/mission-control-gitlab/auth.mjs';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';

const profile=(id='work',site='https://gitlab.com',tokenEnv='WORK_TOKEN')=>({id,kind:'api',site,auth:{kind:'bearer',tokenEnv}});
const safeError=code=>error=>{
  assert.equal(error.code,code);assert.doesNotMatch(error.stack,/fixture-work-token|fixture-personal-token|PRIVATE_PROVIDER_BODY|PRIVATE_CREDENTIAL/);
  assert.doesNotMatch(JSON.stringify(publicTrackerError(error)),/fixture-work-token|fixture-personal-token|PRIVATE_PROVIDER_BODY|PRIVATE_CREDENTIAL/);return true;
};
async function endpoint(t,token){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-auth-'));
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],state={status:200,redirect:null};
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{
    requests.push({url:req.url,method:req.method,authorization:req.headers.authorization,privateToken:req.headers['private-token']});
    if(state.redirect){res.writeHead(302,{location:state.redirect});res.end();return;}
    const status=req.headers.authorization==='Bearer '+token?state.status:401;
    res.writeHead(status,{'content-type':'application/json','x-next-page':'','retry-after':'2'});
    res.end(JSON.stringify(status===200?[{id:1}]:{message:'PRIVATE_PROVIDER_BODY '+token}));
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {origin:'https://127.0.0.1:'+server.address().port,ca,requests,state};
}

test('GitLab owns an exact API/bearer profile and canonical cloud/self-managed API bases',()=>{
  assert.deepEqual(gitlabEndpoints('https://gitlab.com/'),{site:'https://gitlab.com',apiBase:'https://gitlab.com/api/v4'});
  assert.deepEqual(gitlabEndpoints('https://gitlab.example.com'),{site:'https://gitlab.example.com',apiBase:'https://gitlab.example.com/api/v4'});
  assert.equal(gitlabEndpoints('https://gitlab.example.com:8443').apiBase,'https://gitlab.example.com:8443/api/v4');
  const input=profile(),validated=validateGitlabConnection(input);assert.deepEqual(validated,input);assert.notEqual(validated.auth,input.auth);
  for(const change of [{kind:'gitlab'},{kind:'cli'},{id:'constructor'},{id:'../work'},{auth:{kind:'basic',usernameEnv:'USER',tokenEnv:'WORK_TOKEN'}},{auth:{kind:'bearer',token:'PRIVATE_CREDENTIAL'}},{auth:{kind:'bearer',tokenEnv:'literal token'}},{auth:{kind:'bearer',tokenEnv:'WORK_TOKEN',extra:true}},{token:'PRIVATE_CREDENTIAL'},{apiBase:'https://another.invalid/api/v4'},{glab:{account:'work'}}])assert.throws(()=>validateGitlabConnection({...input,...change}),safeError('INVALID_CONNECTION'));
  for(const site of ['http://gitlab.com','https://user:PRIVATE_CREDENTIAL@gitlab.com','https://gitlab.com/api/v4','https://gitlab.com/path/..','https://gitlab.com?','https://gitlab.com?token=PRIVATE_CREDENTIAL','https://gitlab.com#','https://gitlab.com/#fragment','https://gitlab.com\\api'])assert.throws(()=>validateGitlabConnection(profile('work',site)),safeError('INVALID_URL'));
});

test('credential resolution succeeds with CLI process execution and glab filesystem access forbidden',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-no-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config=path.join(root,'config.yml'),initial='PRIVATE_CREDENTIAL must remain unread and unchanged\n';await fs.writeFile(config,initial);
  const moduleUrl=new URL('../src/mods/mission-control-gitlab/auth.mjs',import.meta.url),repo=fileURLToPath(new URL('../',import.meta.url));
  const profiles=[profile(),profile('personal','https://gitlab.example.com','PERSONAL_TOKEN')];
  const code=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {spawnSync} from 'node:child_process';
    import {resolveGitlabAuth} from ${JSON.stringify(moduleUrl.href)};
    assert.throws(()=>fs.readFileSync(process.env.GLAB_CONFIG_DIR+'/config.yml'),e=>e.code==='ERR_ACCESS_DENIED');
    assert.throws(()=>spawnSync(process.execPath,['--version']),e=>e.code==='ERR_ACCESS_DENIED');
    const results=${JSON.stringify(profiles)}.map(c=>resolveGitlabAuth(c));
    process.stdout.write(JSON.stringify(results));
  `;
  const args=['--permission','--allow-fs-read='+repo,'--input-type=module','-e',code];
  const child=spawnSync(process.execPath,args,{encoding:'utf8',env:{GLAB_CONFIG_DIR:root,WORK_TOKEN:'fixture-work-token',PERSONAL_TOKEN:'fixture-personal-token'}});
  assert.equal(child.status,0,child.stderr);assert.doesNotMatch(JSON.stringify(args)+child.stdout+child.stderr,/fixture-work-token|fixture-personal-token|PRIVATE_CREDENTIAL must/);
  assert.deepEqual(JSON.parse(child.stdout),profiles.map(connection=>({connection,apiBase:connection.site+'/api/v4'})));
  assert.equal(await fs.readFile(config,'utf8'),initial);assert.deepEqual(await fs.readdir(root),['config.yml']);
});

test('simultaneous profiles send separate Bearer headers to their exact API bases without global auth changes',async t=>{
  const a=await endpoint(t,'fixture-work-token'),b=await endpoint(t,'fixture-personal-token');
  const env={WORK_TOKEN:'fixture-work-token',PERSONAL_TOKEN:'fixture-personal-token'},before={...env};
  const inputA=profile('work',a.origin),inputB=profile('personal',b.origin,'PERSONAL_TOKEN');
  const authA=resolveGitlabAuth(inputA,{env}),authB=resolveGitlabAuth(inputB,{env});
  assert.deepEqual(env,before);assert.doesNotMatch(JSON.stringify([authA,authB]),/fixture-work-token|fixture-personal-token|authorization|private-token/);
  inputA.auth.tokenEnv='PERSONAL_TOKEN';env.WORK_TOKEN='changed-after-capture';
  const route='/projects/acme%2Fweb%2Fclient/issues?state=all&per_page=50&page=1';
  assert.deepEqual(await Promise.all([gitlabRequest(authA,authA.apiBase+route,{ca:a.ca,requirePageHeader:true}),gitlabRequest(authB,authB.apiBase+route,{ca:b.ca,requirePageHeader:true})]),[{value:[{id:1}],nextPage:null},{value:[{id:1}],nextPage:null}]);
  assert.deepEqual(a.requests,[{url:'/api/v4'+route,method:'GET',authorization:'Bearer fixture-work-token',privateToken:undefined}]);
  assert.deepEqual(b.requests,[{url:'/api/v4'+route,method:'GET',authorization:'Bearer fixture-personal-token',privateToken:undefined}]);
  authA.connection.site=b.origin;authA.apiBase=b.origin+'/api/v4';
  await assert.rejects(gitlabRequest(authA,b.origin+'/api/v4/projects/1',{ca:b.ca}),safeError('UNTRUSTED_ORIGIN'));assert.equal(b.requests.length,1);
});

test('missing credentials, invalid sites, foreign APIs and credential query parameters fail before network I/O',async t=>{
  const f=await endpoint(t,'fixture-work-token'),input=profile('work',f.origin);
  for(const value of [undefined,'','bad\r\nheader','padded token','non-ascii-é','x'.repeat(16385)])assert.throws(()=>resolveGitlabAuth(input,{env:{WORK_TOKEN:value}}),safeError('AUTH_REQUIRED'));
  const reads=[],env=new Proxy({WORK_TOKEN:'fixture-work-token'},{get(target,key){reads.push(key);return target[key];}});
  assert.throws(()=>resolveGitlabAuth({...input,site:f.origin+'/api/v4'},{env}),safeError('INVALID_URL'));assert.deepEqual(reads,[]);
  const auth=resolveGitlabAuth(input,{env});assert.deepEqual(reads,['WORK_TOKEN']);
  for(const route of ['/login','/api/v40/projects','/api/v4/../login','/api/v4/projects?access_token=PRIVATE_CREDENTIAL','/api/v4/projects?PRIVATE-TOKEN=PRIVATE_CREDENTIAL','/api/v4/projects?authorization=PRIVATE_CREDENTIAL'])await assert.rejects(gitlabRequest(auth,f.origin+route,{ca:f.ca}),safeError('INVALID_URL'));
  await assert.rejects(gitlabRequest(auth,'https://another.invalid/api/v4/projects'),safeError('UNTRUSTED_ORIGIN'));
  await assert.rejects(gitlabRequest({},f.origin+'/api/v4/projects',{ca:f.ca}),safeError('INVALID_CONNECTION'));
  assert.equal(f.requests.length,0);
});

test('redirects, authentication failures and rate limits stay redacted and never forward a token',async t=>{
  const f=await endpoint(t,'fixture-work-token'),sink=await endpoint(t,'fixture-work-token');
  const auth=resolveGitlabAuth(profile('work',f.origin),{env:{WORK_TOKEN:'fixture-work-token'}}),url=f.origin+'/api/v4/projects/1';
  for(const [status,code]of [[401,'AUTH_REQUIRED'],[403,'PERMISSION_DENIED'],[429,'RATE_LIMITED']]){
    f.state.status=status;await assert.rejects(gitlabRequest(auth,url,{ca:f.ca}),error=>{safeError(code)(error);assert.equal(error.status,status);assert.equal(error.retryAfterMs,2000);return true;});
  }
  for(const redirect of [sink.origin+'/api/v4/projects/1',f.origin+'/api/v4/projects/2']){
    f.state.redirect=redirect;const before=f.requests.length;await assert.rejects(gitlabRequest(auth,url,{ca:f.ca}),safeError('UNTRUSTED_ORIGIN'));assert.equal(f.requests.length,before+1);assert.equal(sink.requests.length,0);
  }
});
