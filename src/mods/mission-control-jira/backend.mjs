import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TrackerError,publicTrackerError,validateTrackerRequest} from '../../shared/tracker-transport.mjs';
import {TrackerModelError,trackerScope,trackerScopeKey,validateRepoBinding,validateSnapshot} from '../../shared/tracker-model.js';
import {fetchJiraIssues,probeJiraApi} from './api.mjs';
import {fetchJiraCli,probeJiraCli} from './cli.mjs';
import {fetchJiraMcp,probeJiraMcp} from './mcp.mjs';

const hash=value=>createHash('sha256').update(value).digest('base64url');
const fail=code=>{throw new TrackerError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function readCursor(value,scope){
  if(!value)return undefined;let parsed;
  try{if(!/^[A-Za-z0-9_-]+$/.test(value))fail('INVALID_SCOPE');parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(parsed)||Object.keys(parsed).sort().join(',')!=='cursor,scope,v'||parsed.v!==1||parsed.scope!==hash(trackerScopeKey(scope))||typeof parsed.cursor!=='string'||!parsed.cursor.length||parsed.cursor.length>8192||/[\u0000-\u001f\u007f]/.test(parsed.cursor))fail('INVALID_SCOPE');return parsed.cursor;
}
function writeCursor(cursor,scope){const value=Buffer.from(JSON.stringify({v:1,scope:hash(trackerScopeKey(scope)),cursor}),'utf8').toString('base64url');return value.length<=8192?value:null;}

/** The executable helper's only public operations are bounded reads and setup probes. */
export async function dispatchJira(input,options={}){
  try{
    const request=validateTrackerRequest(input);request.binding=validateRepoBinding(request.binding);
    const kind=request.connection.kind,adapter=kind==='api'?{read:fetchJiraIssues,probe:probeJiraApi,options:options.api}:kind==='cli'?{read:fetchJiraCli,probe:probeJiraCli,options:options.cli}:{read:fetchJiraMcp,probe:probeJiraMcp,options:options.mcp};
    const clock=options.clock||adapter.options?.clock||(()=>Date.now());if(typeof clock!=='function')fail('INVALID_REQUEST');
    const adapterOptions={...(adapter.options||{}),clock,...(options.env?{env:options.env}:{})};
    if(request.operation==='probe'){
      if(input.cursor!==undefined&&input.cursor!==null)fail('INVALID_REQUEST');
      const probe=await adapter.probe(request,adapterOptions);
      return {v:1,ok:true,operation:'probe',connection:request.connection,probe};
    }
    const requestedScope=trackerScope('jira',input.connection,request.binding),canonicalScope=trackerScope('jira',request.connection,request.binding);
    if(requestedScope.site!==canonicalScope.site)fail('CANONICAL_SITE_REQUIRED');
    const cursor=readCursor(input.cursor,requestedScope);
    const adapterRequest={...request};delete adapterRequest.cursor;if(cursor)adapterRequest.cursor=cursor;
    const chunk=validateSnapshot(await adapter.read(adapterRequest,adapterOptions),canonicalScope,{now:clock()});
    const result={...chunk,scope:requestedScope};delete result.cursor;
    if(chunk.cursor){const external=writeCursor(chunk.cursor,requestedScope);if(external)result.cursor=external;else result.error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};}
    return {v:1,ok:true,operation:'issues',snapshot:validateSnapshot(result,requestedScope,{now:clock()})};
  }catch(error){const mapped=error instanceof TrackerModelError?new TrackerError(['INVALID_SNAPSHOT','INVALID_ISSUE'].includes(error.code)?'INVALID_RESPONSE':error.code==='INVALID_BINDING'?'INVALID_SCOPE':error.code):error;return {v:1,ok:false,error:publicTrackerError(mapped)};}
}

export async function main(argv=process.argv.slice(2)){
  let result;
  try{if(argv.length!==1||Buffer.byteLength(argv[0],'utf8')>65536)fail('INVALID_REQUEST');result=await dispatchJira(JSON.parse(argv[0]));}
  catch{result={v:1,ok:false,error:publicTrackerError(new TrackerError('INVALID_REQUEST'))};}
  const serialized=JSON.stringify(result);
  if(Buffer.byteLength(serialized,'utf8')>8*1024*1024){process.stdout.write(JSON.stringify({v:1,ok:false,error:publicTrackerError(new TrackerError('RESPONSE_TOO_LARGE'))})+'\n');return;}
  process.stdout.write(serialized+'\n');
}
let executable=false;try{executable=Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}catch{}
if(executable)await main();
