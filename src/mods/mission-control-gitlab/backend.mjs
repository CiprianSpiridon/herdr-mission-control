import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gitlabProjectPath} from '../../shared/config.js';
import {TrackerError,publicTrackerError,validateTrackerRequest} from '../../shared/tracker-transport.mjs';
import {TrackerModelError,validateRepoBinding,trackerScope,trackerScopeKey,validateSnapshot} from '../../shared/tracker-model.js';
import {validateGitlabConnection} from './auth.mjs';
import {fetchGitlabIssues,gitlabProgressHint,gitlabReadContext,gitlabProjectUrl} from './issues.mjs';
import {fetchGitlabMerges} from './merges.mjs';
import {validateMergeRequest,mergeIdentityKey} from './merge-model.js';
import {validateGitlabReply} from './data.js';

const hash=value=>createHash('sha256').update(value).digest('base64url');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new TrackerError(code);};
function readCursor(value,scope,operation){
  if(!value)return undefined;
  if(operation==='merges'&&value.startsWith('{')){let selector;try{selector=JSON.parse(value);}catch{fail('INVALID_SCOPE');}if(selector?.kind!=='mr-detail')fail('INVALID_SCOPE');return value;}
  let cursor;try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(cursor)||Object.keys(cursor).sort().join(',')!=='cursor,kind,operation,scope,v'||cursor.v!==1||cursor.kind!=='gitlab-list'||cursor.operation!==operation||cursor.scope!==hash(trackerScopeKey(scope))||typeof cursor.cursor!=='string'||!cursor.cursor.length||cursor.cursor.length>8192)fail('INVALID_SCOPE');
  return cursor.cursor;
}
function writeCursor(value,scope,operation){const cursor=Buffer.from(JSON.stringify({v:1,kind:'gitlab-list',operation,scope:hash(trackerScopeKey(scope)),cursor:value}),'utf8').toString('base64url');return cursor.length<=8192?cursor:null;}
async function probeProject(request,options){
  const ctx=gitlabReadContext(options);
  try{
    const auth=ctx.auth(request.connection),raw=(await ctx.call(auth,gitlabProjectUrl(auth,request.binding))).value;
    if(!object(raw)||!(Number.isSafeInteger(raw.id)&&raw.id>0||typeof raw.id==='string'&&/^[1-9][0-9]{0,199}$/.test(raw.id)))fail('INVALID_RESPONSE');
    let projectPath;try{projectPath=gitlabProjectPath(raw.path_with_namespace);}catch{fail('INVALID_RESPONSE');}
    if(raw.web_url!==auth.connection.site+'/'+projectPath)fail('INVALID_SCOPE');
    if(raw.issues_enabled!==undefined&&typeof raw.issues_enabled!=='boolean')fail('INVALID_RESPONSE');
    return {kind:'project',site:auth.connection.site,projectPath,projectId:String(raw.id),issuesEnabled:raw.issues_enabled??null,canonical:projectPath===request.binding.gitlab.projectPath};
  }finally{ctx.cancel();}
}

/** Own-folder reads only. Neither credentials nor another provider's adapter enter the protocol. */
export async function dispatchGitlab(input,options={}){
  try{
    const request=validateTrackerRequest(input,{source:'gitlab',connectionValidator:validateGitlabConnection});request.binding=validateRepoBinding(request.binding);if(!request.binding.gitlab)fail('INVALID_REQUEST');
    const operation=request.operation,clock=options.clock??(()=>Date.now());if(typeof clock!=='function')fail('INVALID_REQUEST');
    const adapterOptions={...(options.api||{}),...(options.env?{env:options.env}:{}),clock};
    if(operation==='probe'){
      if(request.cursor!==undefined&&request.cursor!==null)fail('INVALID_REQUEST');
      return validateGitlabReply({v:1,ok:true,operation,connection:request.connection,probe:await probeProject(request,adapterOptions)},input,{now:clock()});
    }
    const source=operation==='issues'?'gitlab':'gitlab-mr',requestedScope=trackerScope(source,input.connection,request.binding),canonicalScope=trackerScope(source,request.connection,request.binding),cursor=readCursor(input.cursor,requestedScope,operation);
    const adapterRequest={...request};delete adapterRequest.cursor;if(cursor)adapterRequest.cursor=cursor;
    const validators=operation==='merges'?{validateItem:validateMergeRequest,itemKey:mergeIdentityKey}:{};
    const chunk=validateSnapshot(await (operation==='issues'?fetchGitlabIssues:fetchGitlabMerges)(adapterRequest,adapterOptions),canonicalScope,{...validators,now:clock()});
    const snapshot={...chunk,scope:requestedScope};delete snapshot.cursor;
    if(chunk.cursor){const external=writeCursor(chunk.cursor,requestedScope,operation);if(external)snapshot.cursor=external;else snapshot.error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};}
    return validateGitlabReply({v:1,ok:true,operation,snapshot,...(operation==='issues'?{progressHint:gitlabProgressHint(request.binding)}:{})},input,{now:clock()});
  }catch(error){
    const code=error instanceof TrackerModelError?['INVALID_SNAPSHOT','INVALID_ISSUE'].includes(error.code)?'INVALID_RESPONSE':error.code==='INVALID_BINDING'?'INVALID_SCOPE':error.code:error?.name==='GitlabDataError'?error.code:error?.name==='MergeModelError'?'INVALID_RESPONSE':null;
    return {v:1,ok:false,error:publicTrackerError(code?new TrackerError(code):error)};
  }
}
export async function main(argv=process.argv.slice(2)){
  let reply;
  try{if(argv.length!==1||Buffer.byteLength(argv[0])>65536)fail('INVALID_REQUEST');reply=await dispatchGitlab(JSON.parse(argv[0]));}catch{reply={v:1,ok:false,error:publicTrackerError(new TrackerError('INVALID_REQUEST'))};}
  let output=JSON.stringify(reply);if(Buffer.byteLength(output)>8*1024*1024)output=JSON.stringify({v:1,ok:false,error:publicTrackerError(new TrackerError('RESPONSE_TOO_LARGE'))});process.stdout.write(output+'\n');
}
let executable=false;try{executable=Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}catch{}
if(executable)await main();
