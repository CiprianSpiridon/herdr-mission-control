import {validateConfig} from '../../shared/config.js';
import {TrackerError,credentialHeaders,httpsUrl,requestJsonPage} from '../../shared/tracker-transport.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>keys.includes(key));
const fail=code=>{throw new TrackerError(code);};
const grants=new WeakMap();

export function gitlabEndpoints(site){
  if(typeof site!=='string'||!/^https:\/\/[^/?#\\]+\/?$/i.test(site))fail('INVALID_URL');
  const url=httpsUrl(site,{originOnly:true});
  return {site:url.origin,apiBase:url.origin+'/api/v4'};
}

/** GitLabConnection v1 owns its API-only, environment-reference credential shape. */
export function validateGitlabConnection(input){
  try{validateConfig({v:1,preferences:{gitlabConnection:input}});}catch{fail('INVALID_CONNECTION');}
  if(!exact(input,['id','kind','site','auth'])||input.kind!=='api'||typeof input.id!=='string'||!/^[a-z][a-z0-9-]{0,95}$/.test(input.id)||['constructor','prototype'].includes(input.id)
    ||!exact(input.auth,['kind','tokenEnv'])||input.auth.kind!=='bearer'||typeof input.auth.tokenEnv!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.auth.tokenEnv))fail('INVALID_CONNECTION');
  return {id:input.id,kind:'api',site:gitlabEndpoints(input.site).site,auth:{kind:'bearer',tokenEnv:input.auth.tokenEnv}};
}

/** Credentials stay in this helper's memory; the returned descriptor serializes references only. */
export function resolveGitlabAuth(input,{env=process.env}={}){
  const connection=validateGitlabConnection(input),headers=credentialHeaders(connection.auth,env);
  if(!/^[\x21-\x7e]+$/.test(headers.authorization.slice(7)))fail('AUTH_REQUIRED');
  const apiBase=connection.site+'/api/v4',descriptor={connection,apiBase};
  grants.set(descriptor,{site:connection.site,apiBase,headers});
  return descriptor;
}

/** Read only the selected origin's API base; no CLI, global login or provider mutations. */
export async function gitlabRequest(auth,input,{requirePageHeader=false,timeoutMs=12000,maxBytes=1048576,ca,signal}={}){
  const grant=grants.get(auth);if(!grant)fail('INVALID_CONNECTION');
  const url=httpsUrl(input);
  if(url.origin!==grant.site)fail('UNTRUSTED_ORIGIN');
  if(url.pathname!=='/api/v4'&&!url.pathname.startsWith('/api/v4/'))fail('INVALID_URL');
  if([...url.searchParams.keys()].some(key=>/^(?:access[-_]?token|private[-_]?token|api[-_]?(?:key|token)|token|auth|authorization|password|secret)$/i.test(key)))fail('INVALID_URL');
  return requestJsonPage(url.href,{allowedOrigin:grant.site,headers:grant.headers,requirePageHeader,timeoutMs,maxBytes,ca,signal});
}
