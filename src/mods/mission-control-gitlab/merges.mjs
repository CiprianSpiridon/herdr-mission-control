import {createHash} from 'node:crypto';
import {TrackerError,validateTrackerRequest} from '../../shared/tracker-transport.mjs';
import {validateRepoBinding,trackerScope,trackerScopeKey,validateSnapshot} from '../../shared/tracker-model.js';
import {validateGitlabConnection} from './auth.mjs';
import {gitlabReadContext,gitlabProjectUrl,readGitlabProject} from './issues.mjs';
import {validateMergeRequest,mergeIdentityKey} from './merge-model.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const id=value=>positive(value)?String(value):typeof value==='string'&&/^[1-9][0-9]{0,199}$/.test(value)?value:null;
const sha=value=>typeof value==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const hash=value=>createHash('sha256').update(value).digest('base64url');
const fail=code=>{throw new TrackerError(code);};
const unavailable=reason=>({state:'unavailable',reason});
const incomplete=()=>({code:'INCOMPLETE_RESULTS',message:new TrackerError('INCOMPLETE_RESULTS').message});
const limited=()=>({code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message});
const lower=value=>typeof value==='string'?value.toLowerCase():value;
function plain(value){if(value===null||value===undefined)return '';if(typeof value!=='string')fail('INVALID_RESPONSE');return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));}
function clip(value,max){let result='',bytes=0;for(const char of value){const size=Buffer.byteLength(char);if(bytes+size>max)break;result+=char;bytes+=size;}return result;}
function body(value){const clean=plain(value),marker='\n[GitLab description truncated; open the merge request for the full text.]';return Buffer.byteLength(clean)>48000?clip(clean,48000-Buffer.byteLength(marker))+marker:clean;}
function checked(value,scope){try{return validateMergeRequest(value,{scope});}catch{fail('INVALID_RESPONSE');}}
function parse(raw,c,b,projectId,scope){
  if(!object(raw)||!id(raw.id)||!positive(raw.iid)||!text(raw.title)||!['opened','closed','merged','locked'].includes(raw.state)||!sha(raw.sha)||raw.source_project_id!==null&&!id(raw.source_project_id))fail('INVALID_RESPONSE');
  if(id(raw.project_id)!==projectId||raw.target_project_id!==undefined&&id(raw.target_project_id)!==projectId||raw.web_url!==c.site+'/'+b.gitlab.projectPath+'/-/merge_requests/'+raw.iid)fail('INVALID_SCOPE');
  const draft=Object.hasOwn(raw,'draft')?raw.draft:raw.work_in_progress;if(typeof draft!=='boolean')fail('INVALID_RESPONSE');
  const base=raw.diff_refs?.start_sha??raw.diff_refs?.base_sha??null;if(base!==null&&!sha(base))fail('INVALID_RESPONSE');
  if(raw.diff_refs?.head_sha!==undefined&&lower(raw.diff_refs.head_sha)!==lower(raw.sha))fail('INVALID_SCOPE');
  const updatedAt=typeof raw.updated_at==='string'?Date.parse(raw.updated_at):NaN;
  return checked({identity:{kind:'gitlab-mr',connectionId:c.id,site:c.site,projectPath:b.gitlab.projectPath,id:id(raw.id),number:raw.iid},key:'GL-MR-'+raw.iid,title:raw.title,url:raw.web_url,body:body(raw.description),repoBinding:b,state:raw.state==='opened'?'open':raw.state,draft,
    head:{ref:raw.source_branch,sha:raw.sha,repoFullName:id(raw.source_project_id)===projectId?b.gitlab.projectPath:null},base:{ref:raw.target_branch,sha:base},review:unavailable('NOT_LOADED'),discussions:unavailable('NOT_LOADED'),checks:unavailable('NOT_LOADED'),actionContext:{comments:{notes:[],truncated:true},pipeline:null},linkedIssues:[],updatedAt},scope);
}
function cursorRead(value,scope,now){
  if(!value)return null;let c;
  try{c=value.startsWith('{')?JSON.parse(value):/^[-\w]+$/.test(value)?JSON.parse(Buffer.from(value,'base64url').toString('utf8')):null;}catch{fail('INVALID_SCOPE');}
  if(c?.kind==='mr-detail'){
    const i=c.identity;
    if(!exact(c,['v','kind','identity','machine','repoRoot','headSha','baseSha'])||c.v!==1||!exact(i,['kind','connectionId','site','projectPath','id','number'])||i.kind!=='gitlab-mr'||i.connectionId!==scope.connectionId||i.site!==scope.site||i.projectPath!==scope.selection.projectPath||typeof i.id!=='string'||!id(i.id)||!positive(i.number)||c.machine!==scope.machine||c.repoRoot!==scope.repoRoot||!sha(c.headSha)||c.baseSha!==null&&!sha(c.baseSha))fail('INVALID_SCOPE');return c;
  }
  if(!exact(c,['v','kind','scope','projectId','page','count','seen','issuedAt'])||c.v!==1||c.kind!=='mr-list'||c.scope!==hash(trackerScopeKey(scope))||typeof c.projectId!=='string'||!id(c.projectId)||!positive(c.page)||c.page>999999||!Number.isInteger(c.count)||c.count<0||c.count>=1000||!Number.isFinite(c.issuedAt)||c.issuedAt<0||c.issuedAt>now+5000||now-c.issuedAt>=7*86400000||!Array.isArray(c.seen)||c.seen.length>64||c.seen.some(value=>typeof value!=='string'||!/^[-\w]{43}$/.test(value))||new Set(c.seen).size!==c.seen.length)fail('INVALID_SCOPE');return c;
}
const cursorWrite=value=>Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
async function optional(ctx,auth,url,options){
  if(ctx.remaining()<2000)return {unavailable:'BUDGET_EXHAUSTED'};
  try{return await ctx.call(auth,url,options);}catch(error){if(['AUTH_REQUIRED','PERMISSION_DENIED','NOT_FOUND','INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(error.code))return {unavailable:'UNAVAILABLE'};throw error;}
}
function notePosition(raw){
  if(!object(raw))return null;
  const result={oldPath:raw.old_path??null,newPath:raw.new_path??null,oldLine:raw.old_line??null,newLine:raw.new_line??null};
  for(const key of ['oldPath','newPath'])if(result[key]!==null&&(!text(result[key],1024)||result[key].startsWith('/')||/^[A-Za-z]:/.test(result[key])||result[key].includes('\\')||result[key].split('/').some(part=>!part||part==='.'||part==='..')))return null;
  for(const key of ['oldLine','newLine'])if(result[key]!==null&&!positive(result[key]))return null;
  return result;
}
function discussions(response){
  const unknown=reason=>({metadata:unavailable(reason),comments:{notes:[],truncated:true}});
  if(response.unavailable)return unknown(response.unavailable==='BUDGET_EXHAUSTED'?'BUDGET_EXHAUSTED':'DISCUSSIONS_UNAVAILABLE');
  const rows=response.value;if(!Array.isArray(rows)||rows.length>100)return unknown('DISCUSSIONS_UNAVAILABLE');
  const notes=[],threads=new Set(),seen=new Set();let count=0,truncated=rows.length===100||response.nextPage!==null;
  for(const thread of rows){
    if(!text(thread?.id,200)||threads.has(thread.id)||!Array.isArray(thread.notes)||thread.notes.length>100)return unknown('DISCUSSIONS_UNAVAILABLE');threads.add(thread.id);
    for(const raw of thread.notes){
      if(!id(raw?.id)||seen.has(id(raw.id))||typeof raw.resolvable!=='boolean'||raw.resolvable&&typeof raw.resolved!=='boolean')return unknown('DISCUSSIONS_UNAVAILABLE');seen.add(id(raw.id));
      if(!raw.resolvable||raw.resolved)continue;count++;
      if(typeof raw.body!=='string'||!raw.body.trim())return unknown('DISCUSSIONS_UNAVAILABLE');
      const clean=plain(raw.body),marker='\n[Comment text truncated.]',clipped=Buffer.byteLength(clean)>4000?clip(clean,4000-Buffer.byteLength(marker))+marker:clean;
      const note={id:id(raw.id),body:clipped,position:notePosition(raw.position)};
      if(notes.length>=50||Buffer.byteLength(JSON.stringify([...notes,note]))>24000){truncated=true;continue;}
      if(clipped!==clean)truncated=true;notes.push(note);
    }
  }
  return {metadata:{state:'readable',unresolvedCount:count,complete:rows.length<100&&response.nextPage===null},comments:{notes,truncated}};
}
function pipeline(raw,m,projectId){
  const value=raw.head_pipeline;
  if(value===null||value===undefined)return {checks:unavailable('NO_PIPELINE'),evidence:null};
  if(!object(value))return {checks:unavailable('PIPELINE_UNAVAILABLE'),evidence:null};
  const state={success:'success',failed:'failure',running:'pending',pending:'pending'}[value.status];
  if(!state)return {checks:unavailable('PIPELINE_UNAVAILABLE'),evidence:null};
  const checks={state};if(state!=='failure'||m.head.repoFullName===null)return {checks,evidence:null};
  if(value.project_id!==undefined&&id(value.project_id)!==projectId)fail('INVALID_SCOPE');
  const base=m.identity.site+'/'+m.identity.projectPath;
  if(!id(value.id)||value.web_url!==base+'/-/pipelines/'+id(value.id)||!sha(value.sha)||!text(value.ref))return {checks,evidence:null};
  return {checks,evidence:{id:id(value.id),url:value.web_url,sha:value.sha,ref:value.ref,status:'failed',jobs:[],jobsUnavailable:true,jobsTruncated:false}};
}
function jobs(response,evidence,m,projectId){
  if(response.unavailable)return evidence;
  const rows=response.value;if(!Array.isArray(rows)||rows.length>50)return evidence;
  const result=[],seen=new Set();let truncated=rows.length===50||response.nextPage!==null;
  for(const raw of rows){
    if(!id(raw?.id)||raw.status!=='failed'||!text(raw.name,256)||!text(raw.stage,256)||raw.failure_reason!==undefined&&raw.failure_reason!==null&&!text(raw.failure_reason,512))return evidence;
    if(raw.pipeline!==undefined&&(!object(raw.pipeline)||id(raw.pipeline.id)!==evidence.id||raw.pipeline.project_id!==undefined&&id(raw.pipeline.project_id)!==projectId||raw.pipeline.sha!==undefined&&lower(raw.pipeline.sha)!==lower(evidence.sha))||raw.commit!==undefined&&lower(raw.commit?.id)!==lower(evidence.sha)||raw.web_url!==m.identity.site+'/'+m.identity.projectPath+'/-/jobs/'+id(raw.id))fail('INVALID_SCOPE');
    if(seen.has(id(raw.id)))return evidence;seen.add(id(raw.id));
    const job={id:id(raw.id),name:raw.name,stage:raw.stage,url:raw.web_url,failureReason:raw.failure_reason??null};
    if(Buffer.byteLength(JSON.stringify([...result,job]))>12000){truncated=true;continue;}result.push(job);
  }
  return {...evidence,jobs:result,jobsUnavailable:false,jobsTruncated:truncated};
}
function review(approval,discussion,m,projectId){
  if(approval.unavailable)return unavailable(approval.unavailable==='BUDGET_EXHAUSTED'?'BUDGET_EXHAUSTED':'APPROVALS_UNAVAILABLE');
  const raw=approval.value;if(!object(raw)||typeof raw.approved!=='boolean')return unavailable('APPROVALS_UNAVAILABLE');
  for(const [key,wanted]of [['id',m.identity.id],['iid',String(m.identity.number)],['project_id',projectId]])if(raw[key]!==undefined&&id(raw[key])!==wanted)fail('INVALID_SCOPE');
  if(discussion.state==='unavailable')return unavailable(discussion.reason);
  if(discussion.unresolvedCount)return {state:'changesRequested'};
  if(!discussion.complete)return unavailable('DISCUSSIONS_PARTIAL');
  return {state:raw.approved?'approved':'reviewRequired'};
}
function closing(response,m){
  if(response.unavailable)return {links:[],partial:true};
  const rows=response.value;if(!Array.isArray(rows)||rows.length>50)return {links:[],partial:true};
  const links=[],seen=new Set();let partial=rows.length===50||response.nextPage!==null;
  for(const raw of rows){
    if(raw?.web_url===undefined){partial=true;continue;}
    if(!id(raw.id)||!positive(raw.iid)||typeof raw.web_url!=='string'||!raw.web_url.startsWith(m.identity.site+'/')||!raw.web_url.endsWith('/-/issues/'+raw.iid))fail('INVALID_SCOPE');
    if(seen.has(raw.web_url))continue;seen.add(raw.web_url);links.push({kind:'gitlab',id:id(raw.id),url:raw.web_url});
  }
  return {links,partial};
}
async function detail(selector,auth,b,project,scope,ctx){
  const base=gitlabProjectUrl(auth,b)+'/merge_requests/'+selector.identity.number,raw=(await ctx.call(auth,base)).value,m=parse(raw,auth.connection,b,project.projectId,scope);
  if(m.identity.id!==selector.identity.id||m.identity.number!==selector.identity.number||lower(m.head.sha)!==lower(selector.headSha)||selector.baseSha!==null&&lower(m.base.sha)!==lower(selector.baseSha))fail('INVALID_SCOPE');
  const p=pipeline(raw,m,project.projectId),[approval,discussion,issues]=await Promise.all([
    optional(ctx,auth,base+'/approvals'),optional(ctx,auth,base+'/discussions?per_page=100&page=1',{list:false}),optional(ctx,auth,base+'/closes_issues?per_page=50&page=1',{list:false})
  ]);
  const d=discussions(discussion),linked=closing(issues,m);let evidence=p.evidence;
  if(evidence){const url=new URL(gitlabProjectUrl(auth,b)+'/pipelines/'+evidence.id+'/jobs');url.searchParams.set('scope[]','failed');url.searchParams.set('per_page','50');url.searchParams.set('page','1');evidence=jobs(await optional(ctx,auth,url.href,{list:false}),evidence,m,project.projectId);}
  return {merge:checked({...m,review:review(approval,d.metadata,m,project.projectId),discussions:d.metadata,checks:p.checks,actionContext:{comments:d.comments,pipeline:evidence},linkedIssues:linked.links},scope),...(linked.partial?{error:incomplete()}:{})};
}

/** Cheap list summaries and one immutable selected detail share a single helper budget. */
export async function fetchGitlabMerges(input,options={}){
  const r=validateTrackerRequest(input,{source:'gitlab',connectionValidator:validateGitlabConnection});if(r.operation!=='merges')fail('INVALID_REQUEST');
  let b;try{b=validateRepoBinding(r.binding);}catch{fail('INVALID_REQUEST');}
  const scope=trackerScope('gitlab-mr',r.connection,b),ctx=gitlabReadContext(options),now=ctx.clock(),previous=cursorRead(r.cursor,scope,now);
  const snapshot=(data,extras={})=>validateSnapshot({data,fetchedAt:ctx.clock(),scope,truncated:false,...extras},scope,{now:ctx.clock(),validateItem:validateMergeRequest,itemKey:mergeIdentityKey});
  try{
    const auth=ctx.auth(r.connection),project=await readGitlabProject(auth,b,ctx);
    if(previous?.kind==='mr-detail'){const enriched=await detail(previous,auth,b,project,scope,ctx);return snapshot([enriched.merge],enriched.error?{error:enriched.error}:{});}
    if(previous&&previous.projectId!==project.projectId)fail('INVALID_SCOPE');
    const data=[],ids=new Map(),numbers=new Map(),seen=[...(previous?.seen||[])];let page=previous?.page||1,count=previous?.count||0,bytes=0,truncated=false,cursor,error;
    const continuation=()=>{truncated=true;cursor=cursorWrite({v:1,kind:'mr-list',scope:hash(trackerScopeKey(scope)),projectId:project.projectId,page,count,seen,issuedAt:previous?.issuedAt??now});};
    while(true){
      if(ctx.remaining()<2000){continuation();break;}
      const url=new URL(gitlabProjectUrl(auth,b)+'/merge_requests');for(const [key,value]of Object.entries({state:'all',per_page:50,page,order_by:'updated_at',sort:'desc'}))url.searchParams.set(key,String(value));
      const response=await ctx.call(auth,url.href,{list:true}),rows=response.value,signature=rows.length?hash(JSON.stringify(rows.map(row=>[id(row?.id),row?.iid]))):null;
      if(signature&&seen.includes(signature))fail('INVALID_SCOPE');
      const additions=[],overLimit=rows.length>1000-count;let pageBytes=0;
      for(const raw of rows.slice(0,1000-count)){
        const m=parse(raw,auth.connection,b,project.projectId,scope),old=ids.get(m.identity.id);
        if(old&&old!==m.identity.number||numbers.has(m.identity.number)&&numbers.get(m.identity.number)!==m.identity.id)fail('INVALID_SCOPE');
        if(!old){ids.set(m.identity.id,m.identity.number);numbers.set(m.identity.number,m.identity.id);pageBytes+=Buffer.byteLength(JSON.stringify(m));additions.push(m);}
      }
      if(bytes+pageBytes>7*1024*1024){error=limited();continuation();break;}bytes+=pageBytes;data.push(...additions);count+=Math.min(rows.length,1000-count);
      if(signature){seen.push(signature);if(seen.length>64)seen.shift();}
      if(response.nextPage===null){if(overLimit){truncated=true;error=limited();}break;}
      if(count>=1000){truncated=true;error=limited();break;}page=response.nextPage;
    }
    return snapshot(data,{truncated,...(cursor?{cursor}:{}),...(error?{error}:{})});
  }finally{ctx.cancel();}
}
