import {createHash} from 'node:crypto';
import {TrackerError,validateJiraConnection,validateTrackerRequest,apiHeaders,httpsUrl,requestJson} from '../../shared/tracker-transport.mjs';
import {trackerScope,trackerScopeKey,validateIssue,validateSnapshot,issueIdentityKey} from '../../shared/tracker-model.js';

const GATEWAY='https://api.atlassian.com';
const CLOUD_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE=7*86400000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=code=>{throw new TrackerError(code);};
const text=(v,max=4096)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const digest=value=>createHash('sha256').update(value).digest('base64url');
const clean=value=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const incomplete=()=>({code:'INCOMPLETE_RESULTS',message:new TrackerError('INCOMPLETE_RESULTS').message});

export function jiraQuery(binding){
  if(text(binding?.jira?.jql,8192))return binding.jira.jql;
  const project=binding?.jira?.project;if(!text(project,256))fail('INVALID_REQUEST');
  return 'project = "'+project.replaceAll('\\','\\\\').replaceAll('"','\\"')+'" ORDER BY updated DESC';
}

/** Bounded plain task data. No rich-text link, media URL or embedded content is fetched. */
export function adfPlainText(value,{maxBytes=48000}={}){
  if(!Number.isInteger(maxBytes)||maxBytes<256||maxBytes>48000)fail('INVALID_REQUEST');
  const parts=[];let bytes=0,truncated=false;
  const write=raw=>{
    const s=clean(raw),size=Buffer.byteLength(s);
    if(bytes+size<=maxBytes){parts.push(s);bytes+=size;return;}
    let prefix='';for(const c of s){const n=Buffer.byteLength(c);if(bytes+n>maxBytes)break;prefix+=c;bytes+=n;}parts.push(prefix);truncated=true;
  };
  if(value===null||value===undefined)return '';
  if(typeof value==='string')write(value);
  else{
    if(!object(value)||value.type!=='doc'||value.version!==1||!Array.isArray(value.content))fail('INVALID_RESPONSE');
    const blocks=new Set(['paragraph','heading','blockquote','codeBlock','listItem','bulletList','orderedList','tableRow','panel','expand','nestedExpand']);
    const stack=[{node:value,depth:0}];let visited=0;
    while(stack.length&&!truncated){
      const entry=stack.pop();if(entry.suffix!==undefined){write(entry.suffix);continue;}
      const {node,depth}=entry;if(++visited>10000||depth>32)fail('RESPONSE_TOO_LARGE');
      if(!object(node)||!text(node.type,80)||node.content!==undefined&&!Array.isArray(node.content))fail('INVALID_RESPONSE');
      if(node.type==='text'){
        if(typeof node.text!=='string'||node.marks!==undefined&&!Array.isArray(node.marks))fail('INVALID_RESPONSE');write(node.text);
        for(const mark of node.marks||[]){if(!object(mark)||!text(mark.type,80))fail('INVALID_RESPONSE');if(mark.type!=='link')continue;
          const href=mark.attrs?.href;let link;try{link=new URL(href);}catch{}
          if(!text(href,4096)||!link||!['https:','http:'].includes(link.protocol)||link.username||link.password)write(' [Unsupported link]');
          else if(href!==node.text)write(' ('+href+')');
        }
      }else if(node.type==='hardBreak')write('\n');
      else if(node.type==='mention')write(typeof node.attrs?.text==='string'?node.attrs.text:'[mention]');
      else if(node.type==='emoji')write(typeof node.attrs?.text==='string'?node.attrs.text:typeof node.attrs?.shortName==='string'?node.attrs.shortName:'[emoji]');
      else if(node.type==='inlineCard'||node.type==='blockCard'){
        const href=node.attrs?.url;let link;try{link=new URL(href);}catch{}
        write(text(href,4096)&&link&&['https:','http:'].includes(link.protocol)&&!link.username&&!link.password?href:'[Unsupported Jira link]');
      }else if(node.type==='rule')write('\n---\n');
      else if(!node.content?.length&&!['doc','paragraph','tableCell','tableHeader'].includes(node.type))write('[Unsupported Jira content]');
      if(node.type==='listItem')write('- ');
      if(blocks.has(node.type))stack.push({suffix:'\n'});else if(['tableCell','tableHeader'].includes(node.type))stack.push({suffix:'\t'});
      for(let i=(node.content?.length||0)-1;i>=0;i--)stack.push({node:node.content[i],depth:depth+1});
    }
  }
  return parts.join('').trim()+(truncated?'\n[Jira description truncated; open the issue for the full text.]':'');
}

export function normalizeJiraIssue(value,connection,binding,scope){
  const f=value?.fields,status=f?.status,groups={new:'todo',indeterminate:'inProgress',done:'done'},category=status?.statusCategory?.key,group=Object.hasOwn(groups,category)?groups[category]:null;
  if(!group)fail('STATUS_MAPPING_REQUIRED');
  if(!object(value)||!text(value.id,200)||!text(value.key,200)||!object(f)||!text(f.summary,512)||!text(status.name,200))fail('INVALID_RESPONSE');
  const row={identity:{kind:'jira',connectionId:connection.id,site:connection.site,id:value.id},key:value.key,title:f.summary,url:connection.site+'/browse/'+value.key,body:adfPlainText(f.description),statusGroup:group,statusName:status.name,repoBinding:binding};
  if(f.priority!==undefined&&f.priority!==null){if(!text(f.priority.name,128))fail('INVALID_RESPONSE');row.priority=f.priority.name;}
  if(f.updated!==undefined&&f.updated!==null){const time=typeof f.updated==='string'?Date.parse(f.updated):NaN;if(!Number.isFinite(time)||time<0)fail('INVALID_RESPONSE');row.updatedAt=time;}
  try{return validateIssue(row,{scope});}catch{fail('INVALID_RESPONSE');}
}

function context(options={}){
  const {request=requestJson,env=process.env,ca,signal,timeoutMs=18000,clock=()=>Date.now()}=options;
  if(typeof request!=='function'||typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000)fail('INVALID_REQUEST');
  const deadline=Date.now()+timeoutMs;
  return {env,clock,async get(url,headers){const remaining=deadline-Date.now();if(remaining<=0)fail('REQUEST_TIMEOUT');return request(url,{allowedOrigin:httpsUrl(url).origin,headers,timeoutMs:remaining,maxBytes:4194304,ca,signal});}};
}
function tenantOrigin(value){try{return httpsUrl(value,{originOnly:true}).origin;}catch{fail('CANONICAL_SITE_REQUIRED');}}
async function resolveRoute(connection,ctx){
  const c=validateJiraConnection(connection);if(c.kind!=='api')fail('INVALID_CONNECTION');const headers=apiHeaders(c,ctx.env);
  let cloudId=c.cloudId;
  if(!cloudId&&c.auth.kind==='bearer'){
    const resources=await ctx.get(GATEWAY+'/oauth/token/accessible-resources',headers);
    if(!Array.isArray(resources)||resources.length>1000)fail('INVALID_RESPONSE');const candidates=new Set();
    for(const r of resources){
      if(!object(r)||typeof r.url!=='string'||!Array.isArray(r.scopes))fail('INVALID_RESPONSE');
      let site;try{site=httpsUrl(r.url,{originOnly:true}).origin;}catch{continue;}
      if(site!==c.site||!r.scopes.some(s=>typeof s==='string'&&(/:jira(?:-|$)/.test(s)||/:jira$/.test(s))))continue;
      if(typeof r.id!=='string'||!CLOUD_ID.test(r.id))fail('INVALID_RESPONSE');candidates.add(r.id.toLowerCase());
    }
    if(candidates.size!==1)fail('INVALID_SCOPE');cloudId=[...candidates][0];
  }
  const base=cloudId?GATEWAY+'/ex/jira/'+cloudId.toLowerCase():c.site;
  const info=await ctx.get(base+'/rest/api/3/serverInfo',headers);
  if(!object(info)||tenantOrigin(info.baseUrl)!==c.site)fail('CANONICAL_SITE_REQUIRED');
  return {connection:c,base,headers,cloudId:cloudId?.toLowerCase()||null};
}

/** Setup probes the same route as reads and never changes saved configuration. */
export async function probeJiraApi(input,options={}){
  const request=validateTrackerRequest(input);if(request.operation!=='probe')fail('INVALID_REQUEST');
  const route=await resolveRoute(request.connection,context(options));
  return {site:route.connection.site,cloudId:route.cloudId,route:route.cloudId?'gateway':'tenant'};
}

function decodeCursor(value,scope,now){
  if(!value)return null;let c;
  try{if(!/^[A-Za-z0-9_-]+$/.test(value))fail('INVALID_SCOPE');c=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(c)||Object.keys(c).sort().join(',')!=='count,issuedAt,route,scope,seen,token,v'||c.v!==1||c.scope!==digest(trackerScopeKey(scope))||!text(c.token,4096)||!text(c.route,64)||!Number.isInteger(c.count)||c.count<0||c.count>=1000||!Number.isFinite(c.issuedAt)||c.issuedAt>now+5000||now-c.issuedAt>=MAX_AGE||!Array.isArray(c.seen)||c.seen.length>100||c.seen.some(s=>!/^[-\w]{43}$/.test(s))||new Set(c.seen).size!==c.seen.length||c.seen.includes(digest(c.token)))fail('INVALID_SCOPE');
  return c;
}
function encodeCursor(value){const encoded=Buffer.from(JSON.stringify(value),'utf8').toString('base64url');return encoded.length<=8192?encoded:null;}

/** One bounded chunk; the bridge owns caching, append-on-load-more and stale retention. */
export async function fetchJiraIssues(input,options={}){
  const request=validateTrackerRequest(input);if(request.operation!=='issues')fail('INVALID_REQUEST');
  const scope=trackerScope('jira',request.connection,request.binding),ctx=context(options),startedAt=ctx.clock();
  const previous=decodeCursor(request.cursor,scope,startedAt),maxPages=options.maxPages??4;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20)fail('INVALID_REQUEST');
  const route=await resolveRoute(request.connection,ctx),routeHash=digest(route.base);
  if(previous&&previous.route!==routeHash)fail('INVALID_SCOPE');
  let token=previous?.token,count=previous?.count||0,bytes=0,truncated=false,cursor,error,complete=false;
  const seen=new Set(previous?.seen||[]),ids=new Set(),data=[];
  for(let page=0;page<maxPages;page++){
    if(token){const hash=digest(token);if(seen.has(hash))fail('INVALID_SCOPE');seen.add(hash);}
    const url=new URL(route.base+'/rest/api/3/search/jql');url.searchParams.set('jql',jiraQuery(request.binding));url.searchParams.set('maxResults','50');url.searchParams.set('fields','summary,description,status,priority,updated,project');if(token)url.searchParams.set('nextPageToken',token);
    const response=await ctx.get(url.href,route.headers);
    if(!object(response)||!Array.isArray(response.issues)||response.issues.length>50||response.isLast!==undefined&&typeof response.isLast!=='boolean'||response.nextPageToken!==undefined&&response.nextPageToken!==null&&!text(response.nextPageToken,4096)||response.warnings!==undefined&&!Array.isArray(response.warnings))fail('INVALID_RESPONSE');
    const next=response.nextPageToken||null;
    if(response.isLast===false&&!next||response.isLast===true&&next)fail('INVALID_RESPONSE');
    if(next&&(seen.has(digest(next))||next===token))fail('INVALID_SCOPE');
    for(const raw of response.issues){
      if(count>=1000){truncated=true;break;}count++;
      const issue=normalizeJiraIssue(raw,route.connection,request.binding,scope),id=issueIdentityKey(issue);if(ids.has(id))continue;
      const size=Buffer.byteLength(JSON.stringify(issue));if(bytes+size>7*1024*1024){truncated=true;error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};break;}
      ids.add(id);data.push(issue);bytes+=size;
    }
    if(error)break;
    if(response.warnings?.length){truncated=true;error=incomplete();break;}
    if(!next){if(response.isLast===true||response.nextPageToken===null)complete=true;else{truncated=true;error=incomplete();}break;}
    if(count>=1000||seen.size>=100){truncated=true;break;}
    token=next;
    if(page===maxPages-1){truncated=true;cursor=encodeCursor({v:1,scope:digest(trackerScopeKey(scope)),route:routeHash,token,count,seen:[...seen],issuedAt:previous?.issuedAt??startedAt});if(!cursor)error=incomplete();}
  }
  if(!complete)truncated=true;
  return validateSnapshot({data,fetchedAt:ctx.clock(),scope,truncated,...(cursor?{cursor}:{}),...(error?{error}:{})},scope,{now:ctx.clock()});
}
