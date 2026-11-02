import {createHash} from 'node:crypto';
import {TrackerError,validateTrackerRequest,httpsUrl,requestJson} from '../../shared/tracker-transport.mjs';
import {validateRepoBinding,trackerScope,trackerScopeKey,trackerOrigin,validateSnapshot} from '../../shared/tracker-model.js';
import {validateGithubConnection,resolveGithubAuth} from './auth.mjs';
import {validatePullRequest,pullIdentityKey} from './pull-model.js';

const PAGE_SIZE=50,MAX_PAGES=100,MAX_AGE=7*86400000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max=4096)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const id=value=>positive(value)?String(value):typeof value==='string'&&/^[1-9][0-9]{0,199}$/.test(value)?value:null;
const sha=value=>typeof value==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const lower=value=>typeof value==='string'?value.toLowerCase():value;
const hash=value=>createHash('sha256').update(value).digest('base64url');
const fail=code=>{throw new TrackerError(code);};
const unavailable=reason=>({state:'unavailable',reason});
const limited=()=>({code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message});
function checked(value,scope){try{return validatePullRequest(value,{scope});}catch{fail('INVALID_RESPONSE');}}
function sameUrl(actual,expected){let a,b;try{a=httpsUrl(actual);b=httpsUrl(expected);}catch{fail('INVALID_SCOPE');}if(a.search||a.origin!==b.origin||lower(a.pathname)!==lower(b.pathname))fail('INVALID_SCOPE');}
const apiRepo=(c,b)=>c.apiBase+'/repos/'+encodeURIComponent(b.github.owner)+'/'+encodeURIComponent(b.github.repo);
function bodyText(value){
  if(value===null)return '';if(typeof value!=='string')fail('INVALID_RESPONSE');
  const clean=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  if(Buffer.byteLength(clean)<=48000)return clean;
  let result='',bytes=0;for(const c of clean){const n=Buffer.byteLength(c);if(bytes+n>48000)break;bytes+=n;result+=c;}
  return result+'\n[GitHub description truncated; open the pull request for the full text.]';
}
function jiraLinks(body){
  const links=[],seen=new Set(),pattern=/https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/browse\/[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*(?![A-Za-z0-9_/?#=%-])/g;
  for(const match of body.matchAll(pattern)){
    const url=match[0];if(url.length>4096||seen.has(url))continue;
    try{const parsed=httpsUrl(url),key=parsed.pathname.slice('/browse/'.length);if(trackerOrigin(parsed.origin)!==parsed.origin||parsed.origin+parsed.pathname!==url)continue;seen.add(url);links.push({kind:'jira',id:key,url});}catch{}
    if(links.length===50)break;
  }
  return links;
}
function repositoryName(raw,c){
  if(!object(raw)||!text(raw.full_name,257)||raw.full_name.split('/').length!==2||lower(raw.full_name)!==lower(raw.owner?.login+'/'+raw.name))fail('INVALID_RESPONSE');
  sameUrl(raw.html_url,c.site+'/'+raw.full_name);return raw.full_name;
}
function parsePull(raw,c,b,scope){
  if(!object(raw)||!id(raw.id)||!text(raw.node_id,200)||!positive(raw.number)||!text(raw.title,512)||!['open','closed'].includes(raw.state)||typeof raw.draft!=='boolean'||!Object.hasOwn(raw,'merged_at')||raw.merged_at!==null&&(!text(raw.merged_at,80)||!Number.isFinite(Date.parse(raw.merged_at)))||raw.state==='open'&&raw.merged_at!==null)fail('INVALID_RESPONSE');
  const base=apiRepo(c,b);sameUrl(raw.url,base+'/pulls/'+raw.number);sameUrl(raw.html_url,c.site+'/'+b.github.owner+'/'+b.github.repo+'/pull/'+raw.number);
  if(!object(raw.head)||!object(raw.base)||!sha(raw.head.sha)||!sha(raw.base.sha))fail('INVALID_RESPONSE');
  if(lower(repositoryName(raw.base.repo,c))!==lower(b.github.owner+'/'+b.github.repo))fail('INVALID_SCOPE');
  const headRepo=raw.head.repo===null?null:repositoryName(raw.head.repo,c);
  let author;if(raw.user===null)author={login:null,url:null};else{if(!object(raw.user)||!text(raw.user.login,100))fail('INVALID_RESPONSE');author={login:raw.user.login,url:raw.user.html_url};}
  const updatedAt=typeof raw.updated_at==='string'?Date.parse(raw.updated_at):NaN,body=bodyText(raw.body);
  const pull=checked({identity:{kind:'github-pr',connectionId:c.id,site:c.site,owner:b.github.owner,repo:b.github.repo,number:raw.number},key:'GH-PR-'+raw.number,title:raw.title,url:raw.html_url,body,author,repoBinding:b,state:raw.merged_at!==null?'merged':raw.state,draft:raw.draft,
    head:{ref:raw.head.ref,sha:raw.head.sha,repoFullName:headRepo,available:null},base:{ref:raw.base.ref,sha:raw.base.sha,available:null},review:unavailable('NOT_LOADED'),discussions:unavailable('NOT_LOADED'),checks:unavailable('NOT_LOADED'),linkedIssues:jiraLinks(body),updatedAt},scope);
  return {pull,nodeId:raw.node_id};
}
function context(options){
  const {request=requestJson,env=process.env,ca,signal,timeoutMs=18000,clock=()=>Date.now(),ghCommand,concurrency=4}=options;
  if(typeof request!=='function'||typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)fail('INVALID_REQUEST');
  const deadline=Date.now()+timeoutMs,controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const remaining=()=>{const left=deadline-Date.now();if(left<=0)fail('REQUEST_TIMEOUT');return left;};
  return {clock,cancel:()=>controller.abort(),auth:connection=>resolveGithubAuth(connection,{env,ghCommand,signal:combined,timeoutMs:Math.min(8000,remaining())}),async call(auth,url,body){
    const u=httpsUrl(url);if(u.origin!==auth.allowedOrigin)fail('UNTRUSTED_ORIGIN');
    try{
      const response=await request(u.href,{allowedOrigin:auth.allowedOrigin,headers:auth.headers,method:body?'POST':'GET',...(body?{body}:{}),metadata:true,maxRedirects:0,timeoutMs:remaining(),maxBytes:4194304,ca,signal:combined});
      if(!object(response)||!object(response.headers)||response.url!==u.href||!Number.isInteger(response.status)||response.status<200||response.status>=300)fail('INVALID_RESPONSE');return response;
    }catch(e){if(e instanceof TrackerError&&e.status===403&&e.retryAfterMs!==undefined)throw new TrackerError('RATE_LIMITED',{status:403,retryAfterMs:e.retryAfterMs});throw e;}
  }};
}
async function repository(auth,b,ctx){
  const raw=(await ctx.call(auth,apiRepo(auth.connection,b))).data;
  if(!id(raw?.id)||lower(repositoryName(raw,auth.connection))!==lower(b.github.owner+'/'+b.github.repo))fail('INVALID_SCOPE');return id(raw.id);
}
function readCursor(value,scope,now){
  if(!value)return null;let c;
  if(value.startsWith('{')){
    try{c=JSON.parse(value);}catch{fail('INVALID_SCOPE');}
    const i=c?.identity;
    if(!exact(c,['v','kind','identity','headSha','baseSha'])||c.v!==1||c.kind!=='pr-detail'||!exact(i,['kind','connectionId','site','owner','repo','number'])||i.kind!=='github-pr'||i.connectionId!==scope.connectionId||i.site!==scope.site||lower(i.owner)!==lower(scope.selection.owner)||lower(i.repo)!==lower(scope.selection.repo)||!positive(i.number)||!sha(c.headSha)||!sha(c.baseSha))fail('INVALID_SCOPE');return c;
  }
  try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');c=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!exact(c,['v','kind','scope','repositoryId','page','count','seen','issuedAt'])||c.v!==1||c.kind!=='pr-list'||c.scope!==hash(trackerScopeKey(scope))||typeof c.repositoryId!=='string'||!id(c.repositoryId)||!Number.isInteger(c.page)||c.page<2||c.page>MAX_PAGES||!Number.isInteger(c.count)||c.count<0||c.count>=1000||c.count>(c.page-1)*PAGE_SIZE||!Number.isFinite(c.issuedAt)||c.issuedAt>now+5000||now-c.issuedAt>=MAX_AGE||!Array.isArray(c.seen)||c.seen.length>c.page-1||c.seen.some(v=>!/^[-\w]{43}$/.test(v))||new Set(c.seen).size!==c.seen.length)fail('INVALID_SCOPE');return c;
}
function writeCursor(value){const encoded=Buffer.from(JSON.stringify(value)).toString('base64url');return encoded.length<=8192?encoded:null;}
function nextPage(header,current,repositoryId){
  if(header===undefined)return null;if(!text(header,8192))fail('INVALID_RESPONSE');const entries=header.split(/,(?=\s*<)/);if(entries.length>16)fail('INVALID_RESPONSE');let next=null;
  for(const entry of entries){
    const match=entry.match(/^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"([A-Za-z -]+)"\s*$/i);if(!match)fail('INVALID_RESPONSE');if(!match[2].toLowerCase().split(/\s+/).includes('next'))continue;if(next!==null)fail('INVALID_SCOPE');
    let target;try{target=httpsUrl(new URL(match[1],current).href);}catch{fail('INVALID_SCOPE');}
    const alternate=current.pathname.replace(/\/repos\/[^/]+\/[^/]+\/pulls$/,'/repositories/'+repositoryId+'/pulls');
    if(target.origin!==current.origin||![lower(current.pathname),lower(alternate)].includes(lower(target.pathname)))fail('INVALID_SCOPE');
    for(const key of target.searchParams.keys())if(!['page','state','per_page','sort','direction'].includes(key)||target.searchParams.getAll(key).length!==1||key!=='page'&&target.searchParams.get(key)!==current.searchParams.get(key))fail('INVALID_SCOPE');
    const page=target.searchParams.get('page');if(!/^[1-9][0-9]*$/.test(page||'')||!positive(Number(page))||Number(page)!==Number(current.searchParams.get('page'))+1)fail('INVALID_SCOPE');next=Number(page);
  }
  return next;
}

const DETAIL_QUERY=`query MissionControlPullDetail($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequest {
      id number url state isDraft updatedAt repository { nameWithOwner url }
      headRefName headRefOid baseRefName baseRefOid headRepository { nameWithOwner url }
      headRef { name target { oid } } baseRef { name target { oid } }
      reviewDecision
      reviewThreads(first: 100) { totalCount nodes { id isResolved isOutdated } pageInfo { hasNextPage } }
      statusCheckRollup {
        commit { oid } state
        contexts(first: 100) {
          totalCount pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun { id status conclusion checkSuite { commit { oid } } }
            ... on StatusContext { id state commit { oid } }
          }
        }
      }
      closingIssuesReferences(first: 50) { nodes { id number url repository { nameWithOwner } } pageInfo { hasNextPage } }
    }
  }
}`;
function graphErrors(response){
  if(!object(response))fail('INVALID_RESPONSE');const errors=response.errors??[];
  if(!Array.isArray(errors)||errors.length>100)fail('INVALID_RESPONSE');const denied=new Set();
  for(const e of errors){
    if(!object(e))fail('INVALID_RESPONSE');const type=e.type||e.extensions?.type||e.extensions?.code;
    if(type==='RATE_LIMITED')fail('RATE_LIMITED');
    if(Array.isArray(e.path)&&e.path[0]==='node'&&typeof e.path[1]==='string')denied.add(e.path[1]);else denied.add('*');
  }
  return denied;
}
function complete(connection,max){
  return object(connection)&&Array.isArray(connection.nodes)&&connection.nodes.length<=max&&connection.pageInfo?.hasNextPage===false&&Number.isSafeInteger(connection.totalCount)&&connection.totalCount===connection.nodes.length;
}
function discussionState(connection){
  if(connection===null||connection===undefined)return unavailable('DISCUSSIONS_UNAVAILABLE');
  if(!complete(connection,100))return unavailable('DISCUSSIONS_PARTIAL');
  let count=0;const seen=new Set();
  for(const thread of connection.nodes){if(!text(thread?.id,200)||seen.has(thread.id)||typeof thread.isResolved!=='boolean'||typeof thread.isOutdated!=='boolean')return unavailable('DISCUSSIONS_PARTIAL');seen.add(thread.id);if(!thread.isResolved&&!thread.isOutdated)count++;}
  return count?{state:'actionable',count}:{state:'none',count:0,reason:'NO_ACTIONABLE_COMMENTS'};
}
function checkState(rollup,headSha){
  if(rollup===null||rollup===undefined)return unavailable('NO_CHECKS');
  if(!object(rollup))return unavailable('CHECKS_PARTIAL');
  if(rollup.commit===null||rollup.commit===undefined)return unavailable('CHECKS_UNAVAILABLE');
  if(!sha(rollup.commit.oid))return unavailable('CHECKS_PARTIAL');
  if(lower(rollup.commit.oid)!==lower(headSha))fail('INVALID_SCOPE');
  if(!complete(rollup.contexts,100))return unavailable('CHECKS_PARTIAL');
  if(!rollup.contexts.nodes.length)return unavailable('NO_CHECKS');
  const states=[],seen=new Set();
  for(const row of rollup.contexts.nodes){
    if(!text(row?.id,200)||seen.has(row.id))return unavailable('CHECKS_PARTIAL');seen.add(row.id);
    if(row.__typename==='CheckRun'){
      if(!sha(row.checkSuite?.commit?.oid))return unavailable('CHECKS_PARTIAL');
      if(lower(row.checkSuite.commit.oid)!==lower(headSha))fail('INVALID_SCOPE');
      if(['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(row.status)){states.push('pending');continue;}
      if(row.status!=='COMPLETED')return unavailable('CHECKS_PARTIAL');
      if(['FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE'].includes(row.conclusion))states.push('failure');
      else if(['SUCCESS','NEUTRAL','SKIPPED'].includes(row.conclusion))states.push('success');else return unavailable('CHECKS_PARTIAL');
    }else if(row.__typename==='StatusContext'){
      if(!sha(row.commit?.oid))return unavailable('CHECKS_PARTIAL');
      if(lower(row.commit.oid)!==lower(headSha))fail('INVALID_SCOPE');
      if(['ERROR','FAILURE'].includes(row.state))states.push('failure');else if(['EXPECTED','PENDING'].includes(row.state))states.push('pending');else if(row.state==='SUCCESS')states.push('success');else return unavailable('CHECKS_PARTIAL');
    }else return unavailable('CHECKS_PARTIAL');
  }
  if(!['ERROR','FAILURE','EXPECTED','PENDING','SUCCESS'].includes(rollup.state))return unavailable('CHECKS_PARTIAL');
  if(states.includes('failure'))return {state:'failure'};
  if(['ERROR','FAILURE'].includes(rollup.state))return unavailable('CHECKS_PARTIAL');
  return {state:states.includes('pending')||rollup.state!=='SUCCESS'?'pending':'success'};
}
function verifiedRef(raw,expected,denied,key){
  if(denied.has('*')||denied.has(key))return null;if(raw===null)return false;
  if(!object(raw)||raw.name!==expected.ref||!sha(raw.target?.oid)||lower(raw.target.oid)!==lower(expected.sha))fail('INVALID_SCOPE');return true;
}
function linkedIssues(pull,connection,c){
  const result=[...pull.linkedIssues],seen=new Set(result.map(x=>x.kind+'\0'+x.url));
  if(connection===null||connection===undefined)return result;
  if(!object(connection)||!Array.isArray(connection.nodes)||connection.nodes.length>50||typeof connection.pageInfo?.hasNextPage!=='boolean')fail('INVALID_RESPONSE');
  for(const row of connection.nodes){
    if(!text(row?.id,200)||!positive(row.number)||!text(row.repository?.nameWithOwner,257))fail('INVALID_RESPONSE');
    sameUrl(row.url,c.site+'/'+row.repository.nameWithOwner+'/issues/'+row.number);const key='github\0'+row.url;if(seen.has(key))continue;seen.add(key);result.push({kind:'github',id:row.id,url:row.url});
  }
  return result;
}
async function enrich(parsed,auth,b,scope,ctx){
  const p=parsed.pull,unknown={...p,review:unavailable('REVIEW_UNAVAILABLE'),discussions:unavailable('DISCUSSIONS_UNAVAILABLE'),checks:unavailable('CHECKS_UNAVAILABLE')};let response;
  try{response=(await ctx.call(auth,auth.graphqlUrl,{query:DETAIL_QUERY,variables:{id:parsed.nodeId}})).data;}
  catch(e){if(['PERMISSION_DENIED','NOT_FOUND'].includes(e.code))return {pull:unknown};throw e;}
  const denied=graphErrors(response);if(!object(response.data)||!Object.hasOwn(response.data,'node')){if(denied.size)return {pull:unknown};fail('INVALID_RESPONSE');}const node=response.data.node;
  if(node===null||node===undefined||denied.has('*'))return {pull:unknown};
  if(!object(node)||node.__typename!=='PullRequest'||node.id!==parsed.nodeId||node.number!==p.identity.number||lower(node.repository?.nameWithOwner)!==lower(b.github.owner+'/'+b.github.repo))fail('INVALID_SCOPE');
  sameUrl(node.url,p.url);sameUrl(node.repository.url,auth.connection.site+'/'+b.github.owner+'/'+b.github.repo);
  for(const [key,wanted]of [['headRefName',p.head.ref],['baseRefName',p.base.ref],['headRefOid',p.head.sha],['baseRefOid',p.base.sha]]){
    if(denied.has(key))return {pull:unknown};if(key.endsWith('Oid')?lower(node[key])!==lower(wanted):node[key]!==wanted)fail('INVALID_SCOPE');
  }
  const headName=node.headRepository===null?null:node.headRepository?.nameWithOwner;
  if(!denied.has('headRepository')){if(lower(headName)!==lower(p.head.repoFullName))fail('INVALID_SCOPE');if(headName!==null)sameUrl(node.headRepository.url,auth.connection.site+'/'+headName);}
  if(!['OPEN','CLOSED','MERGED'].includes(node.state)||typeof node.isDraft!=='boolean'||!text(node.updatedAt,80)||!Number.isFinite(Date.parse(node.updatedAt)))fail('INVALID_RESPONSE');
  const review=denied.has('reviewDecision')?unavailable('REVIEW_UNAVAILABLE'):node.reviewDecision===null?unavailable('NO_REVIEW_DECISION'):
    ({APPROVED:{state:'approved'},CHANGES_REQUESTED:{state:'changesRequested'},REVIEW_REQUIRED:{state:'reviewRequired'}}[node.reviewDecision]||unavailable('REVIEW_UNAVAILABLE'));
  const pull={...p,state:node.state.toLowerCase(),draft:node.isDraft,updatedAt:Date.parse(node.updatedAt),head:{...p.head,available:denied.has('headRepository')?null:headName===null?false:verifiedRef(node.headRef,p.head,denied,'headRef')},base:{...p.base,available:verifiedRef(node.baseRef,p.base,denied,'baseRef')},review,
    discussions:denied.has('reviewThreads')?unavailable('DISCUSSIONS_UNAVAILABLE'):discussionState(node.reviewThreads),checks:denied.has('statusCheckRollup')?unavailable('CHECKS_UNAVAILABLE'):checkState(node.statusCheckRollup,p.head.sha),linkedIssues:denied.has('closingIssuesReferences')?p.linkedIssues:linkedIssues(p,node.closingIssuesReferences,auth.connection)};
  const partial=denied.has('closingIssuesReferences')||node.closingIssuesReferences?.pageInfo?.hasNextPage;
  return {pull:checked(pull,scope),...(partial?{error:{code:'INCOMPLETE_RESULTS',message:new TrackerError('INCOMPLETE_RESULTS').message}}:{})};
}

/** List summaries are cheap; an explicit immutable selector enriches only one PR. */
export async function fetchGithubPulls(input,options={}){
  const r=validateTrackerRequest(input,{connectionValidator:validateGithubConnection,source:'github'});if(r.operation!=='pulls')fail('INVALID_REQUEST');
  let b;try{b=validateRepoBinding(r.binding);}catch{fail('INVALID_REQUEST');}
  const scope=trackerScope('github-pr',r.connection,b),ctx=context(options),previous=readCursor(r.cursor,scope,ctx.clock()),maxPages=options.maxPages??4;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20)fail('INVALID_REQUEST');
  const snapshot=(data,extras={})=>validateSnapshot({data,fetchedAt:ctx.clock(),scope,truncated:false,...extras},scope,{now:ctx.clock(),validateItem:validatePullRequest,itemKey:pullIdentityKey});
  try{
    const auth=await ctx.auth(r.connection),repositoryId=await repository(auth,b,ctx);
    if(previous?.kind==='pr-detail'){
      const parsed=parsePull((await ctx.call(auth,apiRepo(auth.connection,b)+'/pulls/'+previous.identity.number)).data,auth.connection,b,scope);
      if(lower(parsed.pull.head.sha)!==lower(previous.headSha)||lower(parsed.pull.base.sha)!==lower(previous.baseSha)||parsed.pull.identity.number!==previous.identity.number)fail('INVALID_SCOPE');
      const result=await enrich(parsed,auth,b,scope,ctx);return snapshot([result.pull],result.error?{error:result.error}:{});
    }
    if(previous&&previous.repositoryId!==repositoryId)fail('INVALID_SCOPE');
    const seen=new Set(previous?.seen||[]),keys=new Map(),data=[];let page=previous?.page||1,count=previous?.count||0,bytes=0,truncated=false,cursor,error;
    for(let n=0;n<maxPages;n++,page++){
      const url=new URL(apiRepo(auth.connection,b)+'/pulls');for(const [key,value]of Object.entries({state:'all',per_page:PAGE_SIZE,sort:'updated',direction:'desc',page}))url.searchParams.set(key,String(value));
      const response=await ctx.call(auth,url.href),rows=response.status===204&&response.data===null?[]:response.data;
      if(!Array.isArray(rows))fail('INVALID_RESPONSE');if(rows.length>PAGE_SIZE)fail('RESPONSE_TOO_LARGE');
      for(const row of rows)if(!id(row?.id)||!positive(row.number))fail('INVALID_RESPONSE');
      if(rows.length){const signature=hash(JSON.stringify(rows.map(row=>[id(row.id),row.number])));if(seen.has(signature))fail('INVALID_SCOPE');seen.add(signature);}
      const next=nextPage(response.headers.link,url,repositoryId);let stopped=false;
      for(const raw of rows){
        if(count>=1000){truncated=true;stopped=true;break;}count++;
        const parsed=parsePull(raw,auth.connection,b,scope),pull=parsed.pull,key=pullIdentityKey(pull),identity=JSON.stringify([id(raw.id),parsed.nodeId]);if(keys.has(key)){if(keys.get(key)!==identity)fail('INVALID_SCOPE');continue;}
        const size=Buffer.byteLength(JSON.stringify(pull));if(bytes+size>7*1024*1024){truncated=true;error=limited();stopped=true;break;}bytes+=size;keys.set(key,identity);data.push(pull);
      }
      if(stopped)break;if(next===null&&rows.length<PAGE_SIZE)break;
      if(page>=MAX_PAGES||count>=1000){truncated=true;error=limited();break;}
      if(n===maxPages-1){truncated=true;cursor=writeCursor({v:1,kind:'pr-list',scope:hash(trackerScopeKey(scope)),repositoryId,page:page+1,count,seen:[...seen],issuedAt:previous?.issuedAt??ctx.clock()});if(!cursor)error=limited();}
    }
    return snapshot(data,{truncated,...(cursor?{cursor}:{}),...(error?{error}:{})});
  }finally{ctx.cancel();}
}
