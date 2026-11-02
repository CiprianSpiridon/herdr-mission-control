import {spawn} from 'node:child_process';
import {validateConfig} from '../../shared/config.js';
import {TrackerError,httpsUrl} from '../../shared/tracker-transport.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const envName=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const fail=code=>{throw new TrackerError(code);};
const credential=value=>{if(typeof value!=='string'||!value.length||value.length>16384||/[^\x21-\x7e]/.test(value))fail('AUTH_REQUIRED');return value;};

/** Explicit public, Enterprise Cloud and Enterprise Server routes, never a redirect guess. */
export function githubEndpoints(site){
  const url=httpsUrl(site,{originOnly:true}),canonical=url.origin;
  if(url.hostname==='github.com'){
    if(url.port)fail('INVALID_CONNECTION');
    return {site:canonical,apiBase:'https://api.github.com',graphqlUrl:'https://api.github.com/graphql',host:url.host};
  }
  const cloud=url.hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.ghe\.com$/);
  if(cloud){
    if(url.port)fail('INVALID_CONNECTION');
    const api='https://api.'+url.hostname;return {site:canonical,apiBase:api,graphqlUrl:api+'/graphql',host:url.host};
  }
  if(url.hostname==='ghe.com'||url.hostname.endsWith('.ghe.com')||url.hostname.endsWith('.github.com'))fail('INVALID_CONNECTION');
  return {site:canonical,apiBase:canonical+'/api/v3',graphqlUrl:canonical+'/api/graphql',host:url.host};
}

/** GitHubConnection v1 is separate from Jira's API/MCP adapter discriminator. */
export function validateGithubConnection(input){
  try{validateConfig({v:1,preferences:{githubConnection:input}});}catch{fail('INVALID_CONNECTION');}
  if(!exact(input,['id','kind','site','apiBase'],['credentialEnv','gh'])||input.kind!=='github'||typeof input.id!=='string'||!/^[a-z][a-z0-9-]{0,95}$/.test(input.id)||['constructor','prototype'].includes(input.id))fail('INVALID_CONNECTION');
  const endpoints=githubEndpoints(input.site),api=httpsUrl(input.apiBase);
  if(api.search||api.href.replace(/\/$/,'')!==endpoints.apiBase)fail('INVALID_CONNECTION');
  const hasEnv=Object.hasOwn(input,'credentialEnv'),hasGh=Object.hasOwn(input,'gh');
  if(hasEnv===hasGh||hasEnv&&!envName(input.credentialEnv))fail('INVALID_CONNECTION');
  if(hasGh&&(!exact(input.gh,['host','account'])||typeof input.gh.host!=='string'||input.gh.host.toLowerCase()!==endpoints.host||typeof input.gh.account!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.gh.account)))fail('INVALID_CONNECTION');
  return {id:input.id,kind:'github',site:endpoints.site,apiBase:endpoints.apiBase,...(hasEnv?{credentialEnv:input.credentialEnv}:{gh:{host:endpoints.host,account:input.gh.account}})};
}

function selectedEnvironment(env,host){
  const selected={...env};
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_DEBUG','DEBUG','GH_REPO'])delete selected[key];
  return {...selected,GH_HOST:host,GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',GH_PAGER:'cat',PAGER:'cat',NO_COLOR:'1'};
}

/** Capture stdout only in helper memory. Never reflect stderr, argv or upstream errors. */
function runGh(command,args,{env,signal,deadline,failureCode}){
  if(signal?.aborted)return Promise.reject(new TrackerError('REQUEST_CANCELLED'));
  const remaining=deadline-Date.now();if(remaining<=0)return Promise.reject(new TrackerError('REQUEST_TIMEOUT'));
  return new Promise((resolve,reject)=>{
    let child,reason,killTimer,timer,bytes=0;const chunks=[];
    const stop=code=>{if(reason)return;reason=new TrackerError(code);if(child?.pid){child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),250);}};
    const cancel=()=>stop('REQUEST_CANCELLED');
    try{child=spawn(command,args,{env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});}catch{reject(new TrackerError('CLI_UNAVAILABLE'));return;}
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();timer=setTimeout(()=>stop('REQUEST_TIMEOUT'),remaining);
    const collect=(chunk,stdout)=>{bytes+=chunk.length;if(bytes>65536)stop('RESPONSE_TOO_LARGE');else if(stdout&&!reason)chunks.push(chunk);};
    child.stdout.on('data',chunk=>collect(chunk,true));child.stderr.on('data',chunk=>collect(chunk,false));
    child.once('error',error=>{reason||=new TrackerError(['ENOENT','EACCES'].includes(error.code)?'CLI_UNAVAILABLE':failureCode);});
    child.once('close',code=>{
      clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',cancel);
      if(reason)return reject(reason);if(code!==0)return reject(new TrackerError(failureCode));
      try{resolve(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{reject(new TrackerError(failureCode));}
    });
  });
}

const flag=(help,name)=>new RegExp('^\\s*(?:-\\w,\\s*)?--'+name+'(?:[ =<]|$)','m').test(help);

/** Returned headers are deliberately non-enumerable: public serialization has no token. */
export async function resolveGithubAuth(input,{env=process.env,signal,timeoutMs=8000,ghCommand='gh'}={}){
  const connection=validateGithubConnection(input),endpoints=githubEndpoints(connection.site);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000||typeof ghCommand!=='string'||!ghCommand||ghCommand.includes('\0'))fail('INVALID_REQUEST');
  if(signal?.aborted)fail('REQUEST_CANCELLED');let token;
  if(connection.credentialEnv)token=credential(env[connection.credentialEnv]);
  else{
    const selected=selectedEnvironment(env,connection.gh.host),deadline=Date.now()+timeoutMs,options={env:selected,signal,deadline};
    const help=await runGh(ghCommand,['auth','token','--help'],{...options,failureCode:'ACCOUNT_SELECTION_UNSUPPORTED'});
    if(!flag(help,'hostname')||!flag(help,'user'))fail('ACCOUNT_SELECTION_UNSUPPORTED');
    const noRefresh=flag(help,'no-refresh');if(!noRefresh&&/\brefresh(?:ed|ing)?\b/i.test(help))fail('ACCOUNT_SELECTION_UNSUPPORTED');
    const args=['auth','token','--hostname',connection.gh.host,'--user',connection.gh.account,...(noRefresh?['--no-refresh']:[])];
    const output=await runGh(ghCommand,args,{...options,failureCode:'AUTH_REQUIRED'});token=credential(output.replace(/\r?\n$/,''));
  }
  const result={connection,allowedOrigin:new URL(connection.apiBase).origin,graphqlUrl:endpoints.graphqlUrl};
  Object.defineProperty(result,'headers',{value:Object.freeze({accept:'application/vnd.github+json',authorization:'Bearer '+token,'x-github-api-version':'2022-11-28','user-agent':'herdr-mission-control'}),enumerable:false});
  return Object.freeze(result);
}
