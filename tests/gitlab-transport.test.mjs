import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {requestJson,requestJsonPage,validateTrackerRequest,publicTrackerError} from '../src/shared/tracker-transport.mjs';

const endpoint='/api/v4/projects/acme%2Fweb%2Fclient/issues';
const query='state=all&issue_type=issue&per_page=50&page=1&order_by=updated_at';
const body=length=>Array.from({length},(_,i)=>({id:i+1}));
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-pages-'));
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],state={value:body(50),headers:{},status:200};
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{
    requests.push({url:req.url,authorization:req.headers.authorization});
    res.writeHead(state.status,{'content-type':'application/json',...state.headers});res.end(JSON.stringify(state.value));
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='https://127.0.0.1:'+server.address().port;
  return {origin,url:origin+endpoint+'?'+query,requests,state,options:{allowedOrigin:origin,ca,requirePageHeader:true,headers:{authorization:'Bearer fixture-private-token'}}};
}
const safeError=(code='INVALID_RESPONSE')=>error=>{
  assert.equal(error.code,code);assert.doesNotMatch(error.stack,/fixture-private-token|PRIVATE_CREDENTIAL|raw-provider-body/);
  assert.doesNotMatch(JSON.stringify(publicTrackerError(error)),/fixture-private-token|PRIVATE_CREDENTIAL|raw-provider-body/);return true;
};

test('source-specific operations and nested project grammar leave Jira and GitHub contracts intact',()=>{
  const connection={id:'work'},binding={machine:'server',repoRoot:'/srv/client',jira:{connectionId:'work',project:'WEB'},github:{connectionId:'work',owner:'acme',repo:'web'},gitlab:{connectionId:'work',projectPath:'acme/web/client'}};
  let validations=0;const connectionValidator=c=>{validations++;return c;};
  const request=operation=>({v:1,operation,connection,binding});
  for(const [source,operations]of Object.entries({jira:['issues','probe'],github:['issues','pulls','probe'],gitlab:['issues','merges','probe']})){
    for(const operation of operations){const input=request(operation),result=validateTrackerRequest(input,{source,connectionValidator});assert.deepEqual(result,input);assert.notEqual(result.binding,binding);}
  }
  for(const [source,operation]of [['jira','pulls'],['jira','merges'],['github','merges'],['gitlab','pulls'],['other','probe']]){
    const before=validations;assert.throws(()=>validateTrackerRequest(request(operation),{source,connectionValidator}),safeError('INVALID_REQUEST'));assert.equal(validations,before);
  }
  const options={source:'gitlab',connectionValidator};
  for(const projectPath of ['a//b','../client','acme/%2Fclient','a/'.repeat(21)+'client','x'.repeat(256)])assert.throws(()=>validateTrackerRequest({...request('issues'),binding:{...binding,gitlab:{connectionId:'work',projectPath}}},options),safeError('INVALID_REQUEST'));
  assert.throws(()=>validateTrackerRequest({...request('issues'),binding:{...binding,gitlab:{connectionId:'other',projectPath:'acme/client'}}},options),safeError('INVALID_REQUEST'));
  assert.equal(validateTrackerRequest({...request('probe'),binding:{machine:null,repoRoot:'/repo'}},options).operation,'probe');
  assert.throws(()=>validateTrackerRequest({...request('issues'),binding:{machine:null,repoRoot:'/repo'}},options),safeError('INVALID_REQUEST'));
});

test('numeric and empty page headers return only value/page while ordinary requestJson is unchanged',async t=>{
  const f=await fixture(t);
  f.state.headers={'x-next-page':'2','set-cookie':'PRIVATE_CREDENTIAL','authorization':'PRIVATE_CREDENTIAL'};
  assert.deepEqual(await requestJsonPage(f.url,f.options),{value:body(50),nextPage:2});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,endpoint+'?'+query);
  assert.deepEqual(await requestJson(f.url,f.options),body(50));
  f.state.headers={'x-next-page':''};
  assert.deepEqual(await requestJsonPage(f.url.replace('page=1&','page=2&'),f.options),{value:body(50),nextPage:null});
  f.state.headers={'x-next-page':'999999'};
  assert.equal((await requestJsonPage(f.url,f.options)).nextPage,999999);
  assert.ok(f.requests.every(r=>r.authorization==='Bearer fixture-private-token'));
});

test('RFC Link fallback accepts reordered unchanged filters and quoted commas; caller advances its original URL',async t=>{
  const f=await fixture(t),next=new URL(f.url);next.searchParams.set('page','2');
  const reordered=new URL(f.origin+endpoint+'?page=2&per_page=50&order_by=updated_at&issue_type=issue&state=all');
  f.state.headers={link:'<'+f.url+'>; rel="first prev", <'+reordered.href+'>; title="next, page"; rel="next last"'};
  const first=await requestJsonPage(f.url,f.options);
  assert.equal(first.nextPage,2);assert.equal(f.requests.length,1);assert.deepEqual(Object.keys(first),['value','nextPage']);
  f.state.value=body(5);f.state.headers={link:'<'+f.url+'>; rel="first prev"'};
  assert.deepEqual(await requestJsonPage(next.href,f.options),{value:body(5),nextPage:null});
  assert.equal(f.requests[1].url,endpoint+'?'+query.replace('page=1&','page=2&'));
  f.state.headers={link:'<?'+query.replace('page=1&','page=3&')+'>; rel=next'};
  assert.equal((await requestJsonPage(next.href,f.options)).nextPage,3);
});

test('missing metadata distinguishes a short terminal page, full incomplete page and object read',async t=>{
  const f=await fixture(t);
  for(const length of [0,49]){f.state.value=body(length);assert.deepEqual(await requestJsonPage(f.url,f.options),{value:body(length),nextPage:null});}
  f.state.value=body(50);await assert.rejects(requestJsonPage(f.url,f.options),safeError('INCOMPLETE_RESULTS'));
  f.state.value=body(51);await assert.rejects(requestJsonPage(f.url,f.options),safeError());
  f.state.value={id:123,name:'Client'};
  assert.deepEqual(await requestJsonPage(f.origin+'/api/v4/projects/123',{...f.options,requirePageHeader:false}),{value:f.state.value,nextPage:null});
  await assert.rejects(requestJsonPage(f.url,f.options),safeError());
});

test('malformed, duplicate, backward and contradictory pagination metadata is rejected',async t=>{
  const f=await fixture(t),page=n=>f.url.replace('page=1&','page='+n+'&');
  const invalid=[
    ...['0','01','-1','1','2.5','1000000','+2','2, 3','not-a-page'].map(value=>({'x-next-page':value})),
    {'x-next-page':['2','2']},
    {'x-next-page':'2',link:'<'+page(3)+'>; rel="next"'},
    {'x-next-page':'',link:'<'+page(2)+'>; rel="next"'},
    {'x-next-page':'2',link:'<'+page(1)+'>; rel="last"'},
    {link:'<'+page(2)+'>; rel="next", <'+page(3)+'>; rel="next"'},
    {link:'<'+page(2)+'>; rel="next next"'},
    {link:'<'+page(2)+'>; rel="next"; rel="last"'},
    {link:'<'+page(2)+'>; rel="next"; anchor="/another"'},
    {link:'<'+page(2)+'>; title="no relation"'},
    {link:'<'+page(2)+'>; rel="next",'},
    {link:'<'+page(2)+'>; rel="next", broken'},
    {link:'<'+page(2)+'>; rel="unknown"'},
    {link:'<'+page(1)+'>; rel="next"'},
  ];
  for(const headers of invalid){f.state.headers=headers;const before=f.requests.length;await assert.rejects(requestJsonPage(f.url,f.options),safeError(),JSON.stringify(headers));assert.equal(f.requests.length,before+1);}
  f.state.headers={'x-next-page':'2'};await assert.rejects(requestJsonPage(page(3),f.options),safeError());
  f.state.headers={'x-next-page':'2',link:'<'+page(2)+'>; rel="next"'};
  assert.equal((await requestJsonPage(f.url,f.options)).nextPage,2);
  f.state.headers={'x-next-page':'',link:'<'+page(1)+'>; rel="last"'};
  assert.equal((await requestJsonPage(f.url,f.options)).nextPage,null);
});

test('foreign, credential-bearing and filter-changing links cause no follow-up request or token disclosure',async t=>{
  const f=await fixture(t),sink=await fixture(t),next=f.url.replace('page=1&','page=2&');
  const invalid=[
    next.replace(f.origin,sink.origin),next.replace('https:','http:'),next.replace('https://','https://user:PRIVATE_CREDENTIAL@'),
    next+'#PRIVATE_CREDENTIAL',next.replace('/issues?','/merge_requests?'),next.replace('state=all','state=opened'),
    next.replace('per_page=50','per_page=100'),next.replace('order_by=updated_at','order_by=id'),
    next+'&page=3',next+'&state=all',next+'&private=PRIVATE_CREDENTIAL',next.replace('issue_type=issue&',''),
    next.replace('page=2&','page=02&'),next.replace('page=2&','page=1000000&'),
  ];
  for(const url of invalid){
    f.state.headers={link:'<'+url+'>; rel="next"'};const before=f.requests.length;
    await assert.rejects(requestJsonPage(f.url,f.options),safeError());assert.equal(f.requests.length,before+1);assert.equal(sink.requests.length,0);
  }
  // A malformed/foreign last link cannot falsely certify a terminal page either.
  f.state.headers={link:'<'+next.replace(f.origin,sink.origin)+'>; rel="last"'};
  await assert.rejects(requestJsonPage(f.url,f.options),safeError());assert.equal(sink.requests.length,0);
});

test('invalid original queries/options fail before I/O, and redirects are not followed',async t=>{
  const f=await fixture(t),sink=await fixture(t);
  for(const url of [f.url+'&page=2',f.url+'&state=all',f.url.replace('page=1&','page=0&'),f.url.replace('page=1&','page=1000000&')])await assert.rejects(requestJsonPage(url,f.options),safeError('INVALID_REQUEST'));
  await assert.rejects(requestJsonPage(f.url,{...f.options,requirePageHeader:'yes'}),safeError('INVALID_REQUEST'));
  await assert.rejects(requestJsonPage(f.url,{...f.options,method:'POST',body:{}}),safeError('INVALID_REQUEST'));
  assert.equal(f.requests.length,0);
  f.state.status=302;
  for(const location of [f.origin+endpoint,sink.url]){
    f.state.headers={location};const before=f.requests.length;
    await assert.rejects(requestJsonPage(f.url,f.options),safeError('UNTRUSTED_ORIGIN'));assert.equal(f.requests.length,before+1);assert.equal(sink.requests.length,0);
  }
});
