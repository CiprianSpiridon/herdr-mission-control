import {createHash} from 'node:crypto';
import {TrackerError,validateTrackerRequest,publicTrackerError} from '../../shared/tracker-transport.mjs';
import {validateRepoBinding,trackerScope,trackerScopeKey,validateIssue,validateSnapshot,issueIdentityKey} from '../../shared/tracker-model.js';
import {validateGitlabConnection,resolveGitlabAuth,gitlabRequest} from './auth.mjs';

const PAGE_SIZE=50,MAX_RECORDS=1000,MAX_OUTPUT=7*1024*1024,MAX_AGE=7*86400000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const id=value=>Number.isSafeInteger(value)&&value>0?String(value):typeof value==='string'&&/^[1-9][0-9]{0,199}$/.test(value)?value:null;
const digest=value=>createHash('sha256').update(value).digest('base64url');
const fail=code=>{throw new TrackerError(code);};
const safeError=error=>{const {code,message,retryAfterMs}=publicTrackerError(error);return {code,message,...(retryAfterMs===undefined?{}:{retryAt:Date.now()+retryAfterMs})};};
function bindingOf(value){try{return validateRepoBinding(value);}catch(error){fail(error.code==='STATUS_MAPPING_REQUIRED'?'STATUS_MAPPING_REQUIRED':'INVALID_REQUEST');}}

/** Shared issue/MR helper budget; at most four live HTTP reads across its callers. */
export function gitlabReadContext({env=process.env,ca,signal,timeoutMs=25000,clock=()=>Date.now()}={}){
  if(typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000)fail('INVALID_REQUEST');
  const started=clock();if(!Number.isFinite(started)||started<0)fail('INVALID_REQUEST');
  const wallDeadline=Date.now()+timeoutMs,deadline=started+timeoutMs,controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let active=0;const waiting=[];
  const remaining=()=>Math.floor(Math.min(wallDeadline-Date.now(),deadline-clock()));
  const check=()=>{if(combined.aborted)fail('REQUEST_CANCELLED');const left=remaining();if(left<=0)fail('REQUEST_TIMEOUT');return left;};
  return {clock,remaining,cancel:()=>controller.abort(),auth:connection=>resolveGitlabAuth(connection,{env}),async call(auth,url,{list=false}={}){
    let acquired=false;
    try{
      check();while(active>=4){await new Promise(resolve=>waiting.push(resolve));check();}
      active++;acquired=true;
      return await gitlabRequest(auth,url,{ca,signal:combined,requirePageHeader:list,timeoutMs:check(),maxBytes:4194304});
    }finally{if(acquired)active--;waiting.shift()?.();}
  }};
}

export function gitlabProjectUrl(auth,binding){return auth.apiBase+'/projects/'+encodeURIComponent(binding.gitlab.projectPath);}
/** Bind the numeric project ID to its exact configured nested project path before listing work. */
export async function readGitlabProject(auth,binding,ctx){
  const raw=(await ctx.call(auth,gitlabProjectUrl(auth,binding))).value;
  if(!object(raw)||!id(raw.id))fail('INVALID_RESPONSE');
  if(raw.path_with_namespace!==binding.gitlab.projectPath||raw.web_url!==auth.connection.site+'/'+binding.gitlab.projectPath)fail('INVALID_SCOPE');
  if(raw.issues_enabled!==undefined&&typeof raw.issues_enabled!=='boolean')fail('INVALID_RESPONSE');
  return {projectId:id(raw.id),projectPath:binding.gitlab.projectPath,issuesEnabled:raw.issues_enabled??null};
}

export async function probeGitlabApi(input,options={}){
  const request=validateTrackerRequest(input,{source:'gitlab',connectionValidator:validateGitlabConnection});if(request.operation!=='probe')fail('INVALID_REQUEST');
  const binding=bindingOf(request.binding);if(!binding.gitlab)fail('INVALID_REQUEST');const ctx=gitlabReadContext(options);
  try{const auth=ctx.auth(request.connection);return {site:auth.connection.site,...await readGitlabProject(auth,binding,ctx)};}finally{ctx.cancel();}
}

export function gitlabProgressHint(binding){
  const selected=bindingOf(binding).gitlab;if(!selected)fail('INVALID_REQUEST');
  return selected.status?.labels.inProgress.length?'':'Open issues appear in To do. Configure In progress labels to show work underway.';
}
function bodyText(value){
  if(value===undefined||value===null)return '';if(typeof value!=='string')fail('INVALID_RESPONSE');
  const clean=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  if(Buffer.byteLength(clean)<=48000)return clean;
  let result='',bytes=0;for(const char of clean){const size=Buffer.byteLength(char);if(bytes+size>48000)break;result+=char;bytes+=size;}
  return result+'\n[GitLab description truncated; open the issue for the full text.]';
}
function statusOf(raw,binding){
  if(raw.state==='closed')return {statusGroup:'done',statusName:'Closed'};
  const mapping=binding.gitlab.status?.labels;
  if(mapping){
    const labels=new Map(raw.labels.map(label=>[label.toLowerCase(),label]));
    const matches=Object.entries(mapping).filter(([,names])=>names.some(name=>labels.has(name.toLowerCase())));
    if(matches.length>1)fail('STATUS_MAPPING_REQUIRED');
    if(matches.length){const [group,names]=matches[0];return {statusGroup:group,statusName:labels.get(names.find(name=>labels.has(name.toLowerCase())).toLowerCase())};}
  }
  return {statusGroup:'todo',statusName:'Open'};
}
function issueRow(raw,connection,binding,projectId){
  const iid=id(raw?.iid);
  if(!object(raw)||!id(raw.id)||!iid||!Number.isSafeInteger(Number(iid))||!text(raw.title)||!['opened','closed'].includes(raw.state)||raw.issue_type!=='issue'||!Array.isArray(raw.labels)||raw.labels.length>100||raw.labels.some(label=>!text(label,200)))fail('INVALID_RESPONSE');
  const url=connection.site+'/'+binding.gitlab.projectPath+'/-/issues/'+iid;
  if(id(raw.project_id)!==projectId||raw.web_url!==url)fail('INVALID_SCOPE');
  const updatedAt=typeof raw.updated_at==='string'?Date.parse(raw.updated_at):NaN;if(!Number.isFinite(updatedAt)||updatedAt<0)fail('INVALID_RESPONSE');
  return {identity:{kind:'gitlab',connectionId:connection.id,site:connection.site,id:id(raw.id)},key:'GL-'+iid,title:raw.title,url,body:bodyText(raw.description),repoBinding:binding,updatedAt};
}

function cursorRead(value,scope,now){
  if(!value)return null;let cursor;
  try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(cursor)||Object.keys(cursor).sort().join(',')!=='count,issuedAt,page,projectId,scope,seen,v'||cursor.v!==1||cursor.scope!==digest(trackerScopeKey(scope))||!id(cursor.projectId)||typeof cursor.projectId!=='string'||!Number.isInteger(cursor.page)||cursor.page<1||cursor.page>999999||!Number.isInteger(cursor.count)||cursor.count<0||cursor.count>=MAX_RECORDS||!Number.isFinite(cursor.issuedAt)||cursor.issuedAt<0||cursor.issuedAt>now+5000||now-cursor.issuedAt>=MAX_AGE||!Array.isArray(cursor.seen)||cursor.seen.length>64||cursor.seen.some(value=>typeof value!=='string'||!/^[-\w]{43}$/.test(value))||new Set(cursor.seen).size!==cursor.seen.length)fail('INVALID_SCOPE');
  return cursor;
}
const cursorWrite=value=>Buffer.from(JSON.stringify(value),'utf8').toString('base64url');

/** One helper follows pages within its budget; partial results carry a scoped continuation. */
export async function fetchGitlabIssues(input,options={}){
  const request=validateTrackerRequest(input,{source:'gitlab',connectionValidator:validateGitlabConnection});if(request.operation!=='issues')fail('INVALID_REQUEST');
  const binding=bindingOf(request.binding),scope=trackerScope('gitlab',request.connection,binding),ctx=gitlabReadContext(options),started=ctx.clock(),previous=cursorRead(request.cursor,scope,started);
  try{
    const auth=ctx.auth(request.connection),project=await readGitlabProject(auth,binding,ctx);
    if(project.issuesEnabled===false)fail('NOT_FOUND');if(previous&&previous.projectId!==project.projectId)fail('INVALID_SCOPE');
    const data=[],identities=new Map(),numbers=new Map(),seen=[...(previous?.seen||[])];
    let page=previous?.page||1,count=previous?.count||0,bytes=0,truncated=false,cursor,error;
    const continuation=()=>{truncated=true;cursor=cursorWrite({v:1,scope:digest(trackerScopeKey(scope)),projectId:project.projectId,page,count,seen,issuedAt:previous?.issuedAt??started});};
    while(true){
      if(ctx.remaining()<2000){continuation();break;}
      const url=new URL(gitlabProjectUrl(auth,binding)+'/issues');
      for(const [key,value]of Object.entries({state:'all',issue_type:'issue',per_page:PAGE_SIZE,order_by:'updated_at',sort:'desc',page}))url.searchParams.set(key,String(value));
      const response=await ctx.call(auth,url.href,{list:true}),rows=response.value;
      const signature=rows.length?digest(JSON.stringify(rows.map(row=>[id(row?.id),id(row?.iid)]))):null;
      if(signature&&seen.includes(signature))fail('INVALID_SCOPE');
      const additions=[],overLimit=rows.length>MAX_RECORDS-count;let pageBytes=0,pageError;
      for(const raw of rows.slice(0,MAX_RECORDS-count)){
        const base=issueRow(raw,auth.connection,binding,project.projectId),identity=issueIdentityKey(base),iid=base.key;
        if(identities.has(identity)&&identities.get(identity)!==iid||numbers.has(iid)&&numbers.get(iid)!==identity)fail('INVALID_SCOPE');
        const duplicate=identities.has(identity);identities.set(identity,iid);numbers.set(iid,identity);
        let row;
        try{row=validateIssue({...base,...statusOf(raw,binding)},{scope});}catch(cause){if(cause instanceof TrackerError&&cause.code==='STATUS_MAPPING_REQUIRED'){pageError=safeError(cause);continue;}if(cause instanceof TrackerError)throw cause;fail('INVALID_RESPONSE');}
        if(!duplicate){pageBytes+=Buffer.byteLength(JSON.stringify(row));additions.push(row);}
      }
      if(bytes+pageBytes>MAX_OUTPUT){error=safeError(new TrackerError('RESPONSE_TOO_LARGE'));continuation();break;}
      data.push(...additions);bytes+=pageBytes;count+=Math.min(rows.length,MAX_RECORDS-count);if(pageError)error=pageError;
      if(signature){seen.push(signature);if(seen.length>64)seen.shift();}
      if(response.nextPage===null){if(overLimit){truncated=true;error??=safeError(new TrackerError('RESPONSE_TOO_LARGE'));}break;}
      if(count>=MAX_RECORDS){truncated=true;error??=safeError(new TrackerError('RESPONSE_TOO_LARGE'));break;}
      page=response.nextPage;
    }
    return validateSnapshot({data,fetchedAt:ctx.clock(),scope,truncated,...(cursor?{cursor}:{}),...(error?{error}:{})},scope,{now:ctx.clock()});
  }finally{ctx.cancel();}
}
