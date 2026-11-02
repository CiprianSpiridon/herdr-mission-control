import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TrackerError,publicTrackerError,validateTrackerRequest,requestJson} from '../../shared/tracker-transport.mjs';
import {TrackerModelError,validateRepoBinding,trackerScope,trackerScopeKey,validateSnapshot} from '../../shared/tracker-model.js';
import {validateGithubConnection,resolveGithubAuth} from './auth.mjs';
import {fetchGithubIssues,probeGithubApi,githubProgressHint} from './issues.mjs';
import {fetchGithubPulls} from './pulls.mjs';
import {validatePullRequest,pullIdentityKey} from './pull-model.js';
import {readGithubProjectFieldsCursor,validateGithubReply} from './data.js';

const hash=value=>createHash('sha256').update(value).digest('base64url');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=200)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const fail=code=>{throw new TrackerError(code);};
function readListCursor(value,scope,operation){
  if(!value)return undefined;
  if(operation==='pulls'&&value.startsWith('{')){
    let c;try{c=JSON.parse(value);}catch{fail('INVALID_SCOPE');}
    if(c?.kind!=='pr-detail')fail('INVALID_SCOPE');return value;
  }
  let c;try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');c=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(c)||Object.keys(c).sort().join(',')!=='cursor,kind,operation,scope,v'||c.v!==1||c.kind!=='github-list'||c.operation!==operation||c.scope!==hash(trackerScopeKey(scope))||!text(c.cursor,8192))fail('INVALID_SCOPE');return c.cursor;
}
function writeListCursor(cursor,scope,operation){const value=Buffer.from(JSON.stringify({v:1,kind:'github-list',operation,scope:hash(trackerScopeKey(scope)),cursor})).toString('base64url');return value.length<=8192?value:null;}
const PROJECT_QUERY=`query MissionControlProjectFields($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    __typename login
    ... on User { projectV2(number: $number) { ...MissionControlProject } }
    ... on Organization { projectV2(number: $number) { ...MissionControlProject } }
  }
}
fragment MissionControlProject on ProjectV2 {
  id number owner { ... on User { login } ... on Organization { login } }
  fields(first: 100, after: $after) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on ProjectV2Field { id }
      ... on ProjectV2IterationField { id }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }
}`;

/** A complete read-only discovery includes repo proof and at most three field pages. */
async function projectFields(request,options){
  let selected;try{selected=readGithubProjectFieldsCursor(request.cursor);}catch{fail('INVALID_REQUEST');}
  const {env=process.env,ca,signal,ghCommand,request:transport=requestJson,timeoutMs=18000}=options;
  if(typeof transport!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000)fail('INVALID_REQUEST');
  const deadline=Date.now()+timeoutMs,controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let calls=0;
  const remaining=()=>{const left=deadline-Date.now();if(left<=0)fail('REQUEST_TIMEOUT');return left;};
  const bounded=async(url,opts)=>{if(++calls>4)fail('INCOMPLETE_RESULTS');try{return await transport(url,{...opts,timeoutMs:Math.min(opts.timeoutMs??remaining(),remaining()),signal:combined,maxRedirects:0,maxBytes:4194304});}catch(error){if(error instanceof TrackerError&&error.status===403&&error.retryAfterMs!==undefined)throw new TrackerError('RATE_LIMITED',{status:403,retryAfterMs:error.retryAfterMs});throw error;}};
  try{
    const repoRequest={...request};delete repoRequest.cursor;
    await probeGithubApi(repoRequest,{env,ca,signal:combined,ghCommand,request:bounded,timeoutMs:remaining(),concurrency:1});
    const auth=await resolveGithubAuth(request.connection,{env,ghCommand,signal:combined,timeoutMs:Math.min(8000,remaining())});
    const fields=[],ids=new Set(),cursors=new Set();let after=null,projectId,total;
    for(let page=0;page<3;page++){
      const result=await bounded(auth.graphqlUrl,{method:'POST',body:{query:PROJECT_QUERY,variables:{owner:selected.owner,number:selected.number,after}},headers:auth.headers,allowedOrigin:auth.allowedOrigin,metadata:true,ca,timeoutMs:remaining()});
      if(!object(result)||result.url!==auth.graphqlUrl||!object(result.headers)||!Number.isInteger(result.status)||result.status<200||result.status>=300)fail('INVALID_RESPONSE');const response=result.data;if(!object(response))fail('INVALID_RESPONSE');
      if(response.errors!==undefined){
        if(!Array.isArray(response.errors)||response.errors.length>100)fail('INVALID_RESPONSE');
        if(response.errors.length){const types=response.errors.map(e=>e?.type||e?.extensions?.type||e?.extensions?.code);fail(types.includes('RATE_LIMITED')?'RATE_LIMITED':types.some(t=>['FORBIDDEN','NOT_FOUND','UNAUTHORIZED','INSUFFICIENT_SCOPES'].includes(t))?'PERMISSION_DENIED':'INCOMPLETE_RESULTS');}
      }
      const owner=response.data?.repositoryOwner,project=owner?.projectV2;
      if(owner===null||project===null)fail('PERMISSION_DENIED');
      if(!['User','Organization'].includes(owner?.__typename)||owner.login?.toLowerCase()!==selected.owner.toLowerCase()||!text(project?.id)||project.number!==selected.number||project.owner?.login?.toLowerCase()!==selected.owner.toLowerCase()||projectId&&projectId!==project.id)fail('INVALID_SCOPE');projectId=project.id;
      const values=project.fields;
      if(!object(values)||!Array.isArray(values.nodes)||values.nodes.length>100||typeof values.pageInfo?.hasNextPage!=='boolean'||!Number.isSafeInteger(values.totalCount)||values.totalCount<0)fail('INVALID_RESPONSE');
      if(values.totalCount>300||total!==undefined&&total!==values.totalCount)fail('INCOMPLETE_RESULTS');total=values.totalCount;
      for(const field of values.nodes){
        if(field===null)fail('PERMISSION_DENIED');
        if(!['ProjectV2Field','ProjectV2IterationField','ProjectV2SingleSelectField'].includes(field?.__typename)||!text(field.id)||ids.has(field.id))fail('INCOMPLETE_RESULTS');ids.add(field.id);
        if(field.__typename!=='ProjectV2SingleSelectField')continue;
        if(!text(field.name)||!Array.isArray(field.options))fail('INVALID_RESPONSE');if(field.options.length>250)fail('INCOMPLETE_RESULTS');
        const options=[],optionIds=new Set();for(const option of field.options){if(!text(option?.id)||!text(option.name)||optionIds.has(option.id))fail('INVALID_RESPONSE');optionIds.add(option.id);options.push({id:option.id,name:option.name});}
        fields.push({id:field.id,name:field.name,options});
      }
      if(!values.pageInfo.hasNextPage){if(ids.size!==total)fail('INCOMPLETE_RESULTS');return {kind:'project-fields',site:request.connection.site,owner:selected.owner,number:selected.number,projectId,fields,complete:true};}
      if(!text(values.pageInfo.endCursor,8192)||cursors.has(values.pageInfo.endCursor)||ids.size>=total)fail('INCOMPLETE_RESULTS');after=values.pageInfo.endCursor;cursors.add(after);
    }
    fail('INCOMPLETE_RESULTS');
  }finally{controller.abort();}
}

/** Only scoped reads/probes are public; credentials remain inside adapter helpers. */
export async function dispatchGithub(input,options={}){
  try{
    const request=validateTrackerRequest(input,{connectionValidator:validateGithubConnection,source:'github'});request.binding=validateRepoBinding(request.binding);if(!request.binding.github)fail('INVALID_REQUEST');
    const operation=request.operation,clock=options.clock||(()=>Date.now());if(typeof clock!=='function')fail('INVALID_REQUEST');
    const adapterOptions={...(options.api||{}),...(options.env?{env:options.env}:{}),clock,concurrency:1};
    const publicConnection={...input.connection,site:request.connection.site};
    if(operation==='probe'){
      const probe=request.cursor?await projectFields(request,adapterOptions):{kind:'repository',...await probeGithubApi(request,adapterOptions)};
      return validateGithubReply({v:1,ok:true,operation,connection:publicConnection,probe},{...input,binding:request.binding},{now:clock()});
    }
    const source=operation==='issues'?'github':'github-pr',requestedScope=trackerScope(source,input.connection,request.binding),canonicalScope=trackerScope(source,request.connection,request.binding);
    const cursor=readListCursor(input.cursor,requestedScope,operation),adapterRequest={...request};delete adapterRequest.cursor;if(cursor)adapterRequest.cursor=cursor;
    const validators=operation==='pulls'?{validateItem:validatePullRequest,itemKey:pullIdentityKey}:{};
    const chunk=validateSnapshot(await (operation==='issues'?fetchGithubIssues:fetchGithubPulls)(adapterRequest,adapterOptions),canonicalScope,{...validators,now:clock()});
    const snapshot={...chunk,scope:requestedScope};delete snapshot.cursor;
    if(chunk.cursor){const publicCursor=writeListCursor(chunk.cursor,requestedScope,operation);if(publicCursor)snapshot.cursor=publicCursor;else snapshot.error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};}
    return validateGithubReply({v:1,ok:true,operation,snapshot,...(operation==='issues'?{progressHint:githubProgressHint(request.binding)}:{})},{...input,binding:request.binding},{now:clock()});
  }catch(error){
    const code=error instanceof TrackerModelError?['INVALID_SNAPSHOT','INVALID_ISSUE'].includes(error.code)?'INVALID_RESPONSE':error.code==='INVALID_BINDING'?'INVALID_SCOPE':error.code:error?.name==='GithubDataError'?['INVALID_REQUEST','INVALID_CONNECTION','INVALID_SCOPE','STATUS_MAPPING_REQUIRED'].includes(error.code)?error.code:'INVALID_RESPONSE':error?.name==='PullModelError'?'INVALID_RESPONSE':null;
    return {v:1,ok:false,error:publicTrackerError(code?new TrackerError(code):error)};
  }
}
export async function main(argv=process.argv.slice(2)){
  let reply;try{if(argv.length!==1||Buffer.byteLength(argv[0])>65536)fail('INVALID_REQUEST');reply=await dispatchGithub(JSON.parse(argv[0]));}catch{reply={v:1,ok:false,error:publicTrackerError(new TrackerError('INVALID_REQUEST'))};}
  let output=JSON.stringify(reply);if(Buffer.byteLength(output)>8*1024*1024)output=JSON.stringify({v:1,ok:false,error:publicTrackerError(new TrackerError('RESPONSE_TOO_LARGE'))});process.stdout.write(output+'\n');
}
let executable=false;try{executable=Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}catch{}
if(executable)await main();
