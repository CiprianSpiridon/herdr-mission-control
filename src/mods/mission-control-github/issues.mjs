import {createHash} from 'node:crypto';
import {TrackerError,validateTrackerRequest,httpsUrl,requestJson} from '../../shared/tracker-transport.mjs';
import {validateRepoBinding,trackerScope,trackerScopeKey,validateIssue,validateSnapshot,issueIdentityKey,mappedStatus} from '../../shared/tracker-model.js';
import {validateGithubConnection,resolveGithubAuth} from './auth.mjs';

const MAX_AGE=7*86400000,MAX_PAGES=100,PAGE_SIZE=50;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=4096)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const number=value=>Number.isSafeInteger(value)&&value>0;
const id=value=>number(value)?String(value):typeof value==='string'&&/^[1-9][0-9]{0,199}$/.test(value)?value:null;
const fail=code=>{throw new TrackerError(code);};
const hash=value=>createHash('sha256').update(value).digest('base64url');
const lower=value=>typeof value==='string'?value.toLowerCase():null;
const limits=()=>({code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message});

function bindingOf(value){try{return validateRepoBinding(value);}catch(e){fail(e.code==='STATUS_MAPPING_REQUIRED'?'STATUS_MAPPING_REQUIRED':'INVALID_REQUEST');}}
export function githubProgressHint(binding){const b=bindingOf(binding);if(!b.github)fail('INVALID_REQUEST');const progress=b.github.status?.labels?.inProgress||b.github.status?.project?.options.inProgress;if(progress?.length)return '';return b.github.status?.project?'Configure an In progress option for the selected Projects status field. Unmapped options are unavailable.':'Open issues without a mapped label appear in To do. Configure label or Projects status mapping to show In progress.';}

function plainBody(value){
  if(value===undefined||value===null)return '';if(typeof value!=='string')fail('INVALID_RESPONSE');
  const clean=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  if(Buffer.byteLength(clean)<=48000)return clean;
  let result='',bytes=0;for(const c of clean){const n=Buffer.byteLength(c);if(bytes+n>48000)break;bytes+=n;result+=c;}return result+'\n[GitHub description truncated; open the issue for the full text.]';
}
function sameUrl(actual,expected){let a,b;try{a=httpsUrl(actual);b=httpsUrl(expected);}catch{fail('INVALID_SCOPE');}if(a.search||a.origin!==b.origin||lower(a.pathname)!==lower(b.pathname))fail('INVALID_SCOPE');}
function repoPath(c,b){return c.apiBase+'/repos/'+encodeURIComponent(b.github.owner)+'/'+encodeURIComponent(b.github.repo);}
function parseIssue(raw,c,b){
  if(!object(raw)||!id(raw.id)||!number(raw.number)||!text(raw.node_id,200)||!text(raw.title,512)||!['open','closed'].includes(raw.state)||!Array.isArray(raw.labels)||raw.labels.length>100)fail('INVALID_RESPONSE');
  const base=repoPath(c,b),url=c.site+'/'+b.github.owner+'/'+b.github.repo+'/issues/'+raw.number;
  sameUrl(raw.html_url,url);sameUrl(raw.url,base+'/issues/'+raw.number);sameUrl(raw.repository_url,base);
  const labels=raw.labels.map(label=>{const name=typeof label==='string'?label:label?.name;if(!text(name,200))fail('INVALID_RESPONSE');return name;});
  const updatedAt=typeof raw.updated_at==='string'?Date.parse(raw.updated_at):NaN;if(!Number.isFinite(updatedAt)||updatedAt<0)fail('INVALID_RESPONSE');
  return {number:raw.number,nodeId:raw.node_id,state:raw.state,labels,row:{identity:{kind:'github',connectionId:c.id,site:c.site,id:id(raw.id)},key:'GH-'+raw.number,title:raw.title,url:raw.html_url,body:plainBody(raw.body),repoBinding:b,updatedAt}};
}
function statusOf(issue,b,projectStatuses){
  if(issue.state==='closed')return {statusGroup:'done',statusName:'Closed'};
  const status=b.github.status;if(status?.project){const mapped=projectStatuses.get(issue.nodeId);if(!mapped)fail('STATUS_MAPPING_REQUIRED');return mapped;}
  if(status?.labels){
    const labels=new Map(issue.labels.map(label=>[lower(label),label])),matches=Object.entries(status.labels).filter(([,names])=>names.some(name=>labels.has(lower(name))));
    if(matches.length>1)fail('STATUS_MAPPING_REQUIRED');
    if(matches.length){const [group,names]=matches[0];return {statusGroup:group,statusName:labels.get(lower(names.find(name=>labels.has(lower(name)))))};}
  }
  return {statusGroup:'todo',statusName:'Open'};
}

function cursorRead(value,scope,now){
  if(!value)return null;let c;
  try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');c=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(c)||Object.keys(c).sort().join(',')!=='count,issuedAt,page,repositoryId,scanned,scope,seen,v'||c.v!==1||c.scope!==hash(trackerScopeKey(scope))||typeof c.repositoryId!=='string'||!id(c.repositoryId)||!Number.isInteger(c.page)||c.page<2||c.page>MAX_PAGES||!Number.isInteger(c.scanned)||c.scanned<0||c.scanned>(c.page-1)*PAGE_SIZE||!Number.isInteger(c.count)||c.count<0||c.count>=1000||c.count>c.scanned||!Number.isFinite(c.issuedAt)||c.issuedAt>now+5000||now-c.issuedAt>=MAX_AGE||!Array.isArray(c.seen)||c.seen.length>c.page-1||c.seen.some(v=>!/^[-\w]{43}$/.test(v))||new Set(c.seen).size!==c.seen.length)fail('INVALID_SCOPE');return c;
}
function cursorWrite(value){const result=Buffer.from(JSON.stringify(value),'utf8').toString('base64url');return result.length<=8192?result:null;}

/** Extract only the page number; never fetch a Link URL or copy its query. */
function nextPage(header,current,repositoryId){
  if(header===undefined)return null;if(!text(header,8192))fail('INVALID_RESPONSE');const links=header.split(/,(?=\s*<)/);if(links.length>16)fail('INVALID_RESPONSE');let next=null;
  for(const entry of links){
    const match=entry.match(/^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"([A-Za-z -]+)"\s*$/i);if(!match)fail('INVALID_RESPONSE');if(!match[2].toLowerCase().split(/\s+/).includes('next'))continue;if(next!==null)fail('INVALID_SCOPE');
    let target;try{target=httpsUrl(new URL(match[1],current).href);}catch{fail('INVALID_SCOPE');}
    const alternate=current.pathname.replace(/\/repos\/[^/]+\/[^/]+\/issues$/,'/repositories/'+repositoryId+'/issues');
    if(target.origin!==current.origin||![lower(current.pathname),lower(alternate)].includes(lower(target.pathname)))fail('INVALID_SCOPE');
    for(const key of target.searchParams.keys()){if(!['page','state','per_page','sort','direction'].includes(key)||target.searchParams.getAll(key).length!==1||key!=='page'&&target.searchParams.get(key)!==current.searchParams.get(key))fail('INVALID_SCOPE');}
    const page=target.searchParams.get('page');if(!/^[1-9][0-9]*$/.test(page||'')||!number(Number(page))||Number(page)!==Number(current.searchParams.get('page'))+1)fail('INVALID_SCOPE');next=Number(page);
  }
  return next;
}

function context(options){
  const {request=requestJson,env=process.env,ca,signal,timeoutMs=18000,clock=()=>Date.now(),ghCommand,concurrency=4}=options;
  if(typeof request!=='function'||typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)fail('INVALID_REQUEST');
  const deadline=Date.now()+timeoutMs,controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const remaining=()=>{const left=deadline-Date.now();if(left<=0)fail('REQUEST_TIMEOUT');return left;};
  return {clock,concurrency,cancel:()=>controller.abort(),async auth(connection){return resolveGithubAuth(connection,{env,ghCommand,signal:combined,timeoutMs:Math.min(8000,remaining())});},async call(auth,url,body){
    const u=httpsUrl(url);if(u.origin!==auth.allowedOrigin)fail('UNTRUSTED_ORIGIN');
    try{const response=await request(u.href,{allowedOrigin:auth.allowedOrigin,headers:auth.headers,method:body?'POST':'GET',...(body?{body}:{}),metadata:true,maxRedirects:0,timeoutMs:remaining(),maxBytes:4194304,ca,signal:combined});
      if(!object(response)||!object(response.headers)||response.url!==u.href||!Number.isInteger(response.status)||response.status<200||response.status>=300)fail('INVALID_RESPONSE');return response;
    }catch(e){if(e instanceof TrackerError&&e.status===403&&e.retryAfterMs!==undefined)throw new TrackerError('RATE_LIMITED',{status:403,retryAfterMs:e.retryAfterMs});throw e;}
  }};
}
async function repository(auth,b,ctx){
  const raw=(await ctx.call(auth,repoPath(auth.connection,b))).data,c=auth.connection;
  if(!object(raw)||!id(raw.id)||!text(raw.full_name,256)||lower(raw.full_name)!==lower(b.github.owner+'/'+b.github.repo)||lower(raw.name)!==lower(b.github.repo)||lower(raw.owner?.login)!==lower(b.github.owner)||typeof raw.has_issues!=='boolean')fail('INVALID_SCOPE');
  sameUrl(raw.html_url,c.site+'/'+b.github.owner+'/'+b.github.repo);return {id:id(raw.id),issuesEnabled:raw.has_issues};
}

const PROJECT_QUERY=`query MissionControlIssueStatus($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id number state repository { name owner { login } }
      projectItems(first: 100, includeArchived: true) {
        nodes {
          id project { id number owner { ... on Organization { login } ... on User { login } } }
          fieldValues(first: 100) {
            nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { id name optionId field { ... on ProjectV2SingleSelectField { id } } } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
function graphData(response){
  if(!object(response))fail('INVALID_RESPONSE');
  if(response.errors!==undefined){if(!Array.isArray(response.errors))fail('INVALID_RESPONSE');if(response.errors.length>100)fail('RESPONSE_TOO_LARGE');if(response.errors.length){const types=response.errors.map(e=>e?.type||e?.extensions?.type||e?.extensions?.code);fail(types.some(type=>['FORBIDDEN','NOT_FOUND','INSUFFICIENT_SCOPES','UNAUTHORIZED'].includes(type))?'PERMISSION_DENIED':types.includes('RATE_LIMITED')?'RATE_LIMITED':types.includes('GRAPHQL_VALIDATION_FAILED')?'STATUS_MAPPING_REQUIRED':'UPSTREAM_UNAVAILABLE');}}
  if(!object(response.data)||!Array.isArray(response.data.nodes))fail('INVALID_RESPONSE');return response.data.nodes;
}
function projectStatus(node,issue,b){
  if(node===null)fail('PERMISSION_DENIED');
  if(!object(node)||node.__typename!=='Issue'||node.id!==issue.nodeId||node.number!==issue.number||lower(node.repository?.name)!==lower(b.github.repo)||lower(node.repository?.owner?.login)!==lower(b.github.owner)||!['OPEN','CLOSED'].includes(node.state))fail('INVALID_SCOPE');
  if(node.state==='CLOSED')return {statusGroup:'done',statusName:'Closed'};
  const items=node.projectItems,p=b.github.status.project;
  if(items===null)fail('PERMISSION_DENIED');if(!object(items)||!Array.isArray(items.nodes)||items.nodes.length>100||typeof items.pageInfo?.hasNextPage!=='boolean')fail('INVALID_RESPONSE');if(items.pageInfo.hasNextPage)fail('INCOMPLETE_RESULTS');
  const matching=items.nodes.filter(item=>item?.project?.number===p.number&&lower(item.project.owner?.login)===lower(p.owner));
  if(!matching.length&&items.nodes.some(item=>!object(item)||!object(item.project)||!text(item.project.owner?.login,128)))fail('PERMISSION_DENIED');if(matching.length!==1)fail('STATUS_MAPPING_REQUIRED');
  const values=matching[0].fieldValues;if(!object(values)||!Array.isArray(values.nodes)||values.nodes.length>100||typeof values.pageInfo?.hasNextPage!=='boolean')fail('INVALID_RESPONSE');if(values.pageInfo.hasNextPage)fail('INCOMPLETE_RESULTS');
  const fields=values.nodes.filter(value=>value?.__typename==='ProjectV2ItemFieldSingleSelectValue'&&value.field?.id===p.fieldId);
  if(fields.length!==1||!text(fields[0].optionId,200)||!text(fields[0].name,200))fail('STATUS_MAPPING_REQUIRED');
  try{return {statusGroup:mappedStatus(fields[0].optionId,p.options),statusName:fields[0].name};}catch{fail('STATUS_MAPPING_REQUIRED');}
}
async function projectStatuses(issues,auth,b,ctx){
  const result=new Map();if(!b.github.status?.project)return result;
  const unique=new Map();for(const issue of issues.filter(issue=>issue.state==='open')){const old=unique.get(issue.nodeId);if(old&&old.number!==issue.number)fail('INVALID_RESPONSE');unique.set(issue.nodeId,issue);}
  const rows=[...unique.values()],chunks=[];for(let i=0;i<rows.length;i+=10)chunks.push(rows.slice(i,i+10));let offset=0,failure;
  await Promise.all(Array.from({length:Math.min(ctx.concurrency,chunks.length)},async()=>{
    try{while(offset<chunks.length&&!failure){const batch=chunks[offset++],response=(await ctx.call(auth,auth.graphqlUrl,{query:PROJECT_QUERY,variables:{ids:batch.map(issue=>issue.nodeId)}})).data,nodes=graphData(response);
      if(nodes.length!==batch.length)fail('INVALID_RESPONSE');const byId=new Map();for(const node of nodes){if(node===null)fail('PERMISSION_DENIED');if(!text(node?.id,200)||byId.has(node.id))fail('INVALID_RESPONSE');byId.set(node.id,node);}
      for(const issue of batch){if(!byId.has(issue.nodeId))fail('INVALID_SCOPE');result.set(issue.nodeId,projectStatus(byId.get(issue.nodeId),issue,b));}
    }}catch(e){failure||=e;ctx.cancel();throw failure;}
  }));return result;
}

/** Repo probe can be shared by setup and reads; it performs no issue or provider write. */
export async function probeGithubApi(input,options={}){
  const r=validateTrackerRequest(input,{connectionValidator:validateGithubConnection,source:'github'});if(r.operation!=='probe')fail('INVALID_REQUEST');const b=bindingOf(r.binding);if(!b.github)fail('INVALID_REQUEST');const ctx=context(options);
  try{const auth=await ctx.auth(r.connection),repo=await repository(auth,b,ctx);return {site:auth.connection.site,owner:b.github.owner,repo:b.github.repo,repositoryId:repo.id,issuesEnabled:repo.issuesEnabled};}finally{ctx.cancel();}
}

/** A bounded REST chunk, with selected Projects enrichment only for visible open issues. */
export async function fetchGithubIssues(input,options={}){
  const r=validateTrackerRequest(input,{connectionValidator:validateGithubConnection,source:'github'});if(r.operation!=='issues')fail('INVALID_REQUEST');const b=bindingOf(r.binding),scope=trackerScope('github',r.connection,b),ctx=context(options),now=ctx.clock(),previous=cursorRead(r.cursor,scope,now),maxPages=options.maxPages??4;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20)fail('INVALID_REQUEST');
  try{
    const auth=await ctx.auth(r.connection),repo=await repository(auth,b,ctx);if(!repo.issuesEnabled)fail('NOT_FOUND');if(previous&&previous.repositoryId!==repo.id)fail('INVALID_SCOPE');
    const seen=new Set(previous?.seen||[]),identities=new Map(),data=[],ids=new Set();let page=previous?.page||1,count=previous?.count||0,scanned=previous?.scanned||0,bytes=0,truncated=false,cursor,error;
    for(let n=0;n<maxPages;n++,page++){
      const url=new URL(repoPath(auth.connection,b)+'/issues');for(const [key,value]of Object.entries({state:'all',per_page:PAGE_SIZE,sort:'updated',direction:'desc',page}))url.searchParams.set(key,String(value));
      const response=await ctx.call(auth,url.href),rows=response.status===204&&response.data===null?[]:response.data;
      if(!Array.isArray(rows))fail('INVALID_RESPONSE');if(rows.length>PAGE_SIZE)fail('RESPONSE_TOO_LARGE');
      for(const raw of rows)if(!object(raw)||!id(raw.id)||!number(raw.number))fail('INVALID_RESPONSE');
      if(rows.length){const signature=hash(JSON.stringify(rows.map(raw=>[id(raw.id),raw.number,Object.hasOwn(raw,'pull_request')])));if(seen.has(signature))fail('INVALID_SCOPE');seen.add(signature);}scanned+=rows.length;
      const next=nextPage(response.headers.link,url,repo.id),issues=rows.filter(raw=>!Object.hasOwn(raw,'pull_request')).map(raw=>parseIssue(raw,auth.connection,b));
      const statuses=await projectStatuses(issues,auth,b,ctx);let stopped=false;
      for(const issue of issues){
        if(count>=1000){truncated=true;stopped=true;break;}count++;
        let checked;try{checked=validateIssue({...issue.row,...statusOf(issue,b,statuses)},{scope});}catch(e){if(e instanceof TrackerError)throw e;fail('INVALID_RESPONSE');}
        const key=issueIdentityKey(checked),identity=JSON.stringify([issue.number,issue.nodeId]);if(identities.has(key)&&identities.get(key)!==identity)fail('INVALID_SCOPE');identities.set(key,identity);if(ids.has(key))continue;
        const size=Buffer.byteLength(JSON.stringify(checked));if(bytes+size>7*1024*1024){truncated=true;error=limits();stopped=true;break;}bytes+=size;ids.add(key);data.push(checked);
      }
      if(stopped)break;
      if(next===null&&rows.length<PAGE_SIZE)break;
      if(page>=MAX_PAGES||count>=1000){truncated=true;error=limits();break;}
      if(n===maxPages-1){truncated=true;cursor=cursorWrite({v:1,scope:hash(trackerScopeKey(scope)),repositoryId:repo.id,page:page+1,count,scanned,seen:[...seen],issuedAt:previous?.issuedAt??now});if(!cursor)error=limits();}
    }
    return validateSnapshot({data,fetchedAt:ctx.clock(),scope,truncated,...(cursor?{cursor}:{}),...(error?{error}:{})},scope,{now:ctx.clock()});
  }finally{ctx.cancel();}
}
