import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildPackage } from './project.mjs';
import { NativeDriver, registerOwnedSocketProcess } from './native-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const HARNESS_SOURCE_SHA256 = sha(await fs.readFile(fileURLToPath(import.meta.url)));
const exists = file => fs.access(file).then(() => true, () => false);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const contexts = new Map();
const ordinaryKeys = ['PATH','LANG','LC_ALL','LC_CTYPE','TZ','TERM','NO_COLOR'];
const selectorSuffixes = {HOME:'h',USERPROFILE:'h',TMPDIR:'t',XDG_CONFIG_HOME:'c',XDG_DATA_HOME:'d',XDG_STATE_HOME:'s',XDG_CACHE_HOME:'k',XDG_RUNTIME_DIR:'r',HERDR_APP_HOME:'app'};
const legacyPins = [
  {path:'evidence/native/agent-menu.json',sha256:'d2f1e3448e2354bdc0ff988520746e389f8ee097d3736f5687fa0bd92b1b6a13',harnessSourceSha256:'7989669a28df40986e7cffc818c5155ecf927c34cd26df910de1cb2dfd225ff9'},
  {path:'evidence/native/spaces.json',sha256:'85e3327f6e69659cb80adafc37f385fccfa53db35d284730a68408d2a783dc91',harnessSourceSha256:'7989669a28df40986e7cffc818c5155ecf927c34cd26df910de1cb2dfd225ff9'},
  {path:'evidence/native/agents.json',sha256:'dfb2170de5d4ac4956fcc386c77b62d2fbb70c7f7c08fd3342686ea8a1dd88e0',harnessSourceSha256:'7989669a28df40986e7cffc818c5155ecf927c34cd26df910de1cb2dfd225ff9'}
];
const plain = value => value !== null && typeof value === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact = (value,keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const pid = value => Number.isSafeInteger(value) && value > 1;
const hex = (value,size=64) => typeof value === 'string' && new RegExp('^[a-f0-9]{'+size+'}$').test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,31})$/.test(value);
const textValue = (value,max=4096) => typeof value === 'string' && value.length>0 && value.length<=max && !/[\u0000-\u001f\u007f]/.test(value);
const canonicalPath = value => textValue(value) && path.isAbsolute(value) && path.resolve(value)===value;
const stable = value => Array.isArray(value)?'['+value.map(stable).join(',')+']':plain(value)?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value);
export class NativeIsolationError extends Error { constructor(message='Native isolation proof is invalid.') { super(message); this.name='NativeIsolationError'; this.code='INVALID_NATIVE_ISOLATION'; } }
const invalid = message => {throw new NativeIsolationError(message);};
const requireProof = (condition,message) => {if(!condition)invalid(message);};
const processDigest = value => sha(JSON.stringify([value.pid,value.uid,value.startedMs,value.executable]));
const freeze = value => {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export function validateFixtureEnvironment(value={},directory){
  requireProof(plain(value),'Fixture environment must be a plain record.');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
  requireProof(keys.length<=32 && keys.every(key=>typeof key==='string' && /^(NODE_EXTRA_CA_CERTS|QA_[A-Z][A-Z0-9_]{0,63})$/.test(key)),'Fixture environment contains a reserved or unsupported key.');
  const result={};
  for(const key of keys){const d=descriptors[key];requireProof(Object.hasOwn(d,'value') && typeof d.value==='string' && Buffer.byteLength(d.value)<=4096 && !/[\u0000-\u001f\u007f]/.test(d.value),'Fixture environment contains an invalid value or accessor.');result[key]=d.value;}
  requireProof(Buffer.byteLength(JSON.stringify(result))<=65536,'Fixture environment exceeds its bound.');
  if(Object.hasOwn(result,'NODE_EXTRA_CA_CERTS')){const file=result.NODE_EXTRA_CA_CERTS;requireProof(canonicalPath(file)&&(file.startsWith(path.join(ROOT,'.harness')+path.sep)||directory&&file.startsWith(directory+path.sep)),'Fixture certificate must use an explicit owned path.');}
  return result;
}

export function isolatedEnvironment(directory,nonce,base=process.env,fixtureEnvironment={}){
  requireProof(canonicalPath(directory)&&/^\/private\/tmp\/mcqa-[A-Za-z0-9]+$/.test(directory)&&hex(nonce,24),'A fresh private context identity is required.');
  const env={};for(const key of ordinaryKeys)if(typeof base[key]==='string')env[key]=base[key];
  Object.assign(env,validateFixtureEnvironment(fixtureEnvironment,directory));
  for(const[key,suffix]of Object.entries(selectorSuffixes))env[key]=path.join(directory,suffix);
  return {...env,HC_SESSION:'mcqa-'+nonce,DO_NOT_TRACK:'1',HERDR_TELEMETRY:'0'};
}

function directoryProof(directory){const stat=sync.lstatSync(directory,{bigint:true});requireProof(stat.isDirectory()&&!stat.isSymbolicLink(),'Private directory changed type.');return {dev:stat.dev.toString(),ino:stat.ino.toString(),uid:Number(stat.uid),mode:Number(stat.mode&0o777n),birthMs:Number(stat.birthtimeNs/1000000n)};}
function contextSelectors(directory,nonce){return {...Object.fromEntries(Object.entries(selectorSuffixes).map(([key,suffix])=>[key,path.join(directory,suffix)])),HC_SESSION:'mcqa-'+nonce};}
function contextSchema(context){
  requireProof(exact(context,['root','nonce','session','uid','createdMs','directory','selectors']),'Private context shape is invalid.');
  const d=context.directory;requireProof(canonicalPath(context.root)&&/^\/private\/tmp\/mcqa-[A-Za-z0-9]+$/.test(context.root)&&hex(context.nonce,24)&&context.session==='mcqa-'+context.nonce&&integer(context.uid)&&integer(context.createdMs),'Private context identity is invalid.');
  requireProof(exact(d,['dev','ino','uid','mode','birthMs'])&&decimal(d.dev)&&decimal(d.ino)&&d.uid===context.uid&&d.mode===0o700&&d.birthMs===context.createdMs,'Private directory proof is invalid.');
  requireProof(stable(context.selectors)===stable(contextSelectors(context.root,context.nonce)),'Private context selectors are invalid.');
}
export function verifyPrivateSelectors(context,env,expectedDirectories){
  contextSchema(context);requireProof(context.uid===process.getuid?.(),'Private context UID changed.');
  requireProof(stable(directoryProof(context.root))===stable(context.directory)&&sync.realpathSync(context.root)===context.root,'Private root ownership or generation changed.');
  for(const[key,suffix]of Object.entries(selectorSuffixes)){const directory=path.join(context.root,suffix),d=directoryProof(directory);requireProof(env?.[key]===directory&&d.uid===context.uid&&d.mode===0o700&&sync.realpathSync(directory)===directory,'Private selector directory ownership changed.');if(expectedDirectories)requireProof(stable(d)===stable(expectedDirectories[directory]),'Private selector directory generation changed.');}
  requireProof(env.HC_SESSION===context.session,'Private core selector changed.');
  for(const key of Object.keys(env))if(/^(HC_|HERDR_)/.test(key))requireProof(key==='HC_SESSION'||key==='HERDR_APP_HOME'||key==='HERDR_TELEMETRY'&&env[key]==='0','An inherited control selector is forbidden.');
  for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GROK_CONFIG_DIR','ZDOTDIR','NODE_OPTIONS'])requireProof(!Object.hasOwn(env,key),'An inherited provider or shell context is forbidden.');
  return true;
}

function controlKind(executable){let name=path.basename(executable);if(path.isAbsolute(executable)&&sync.existsSync(executable))name=path.basename(sync.realpathSync(executable));return name==='hc'?'hc':['herdr-app','Herdr'].includes(name)?'app':null;}
function staticHelp(kind,args){return args.length===1&&(kind==='hc'?['--help','--version','-V','--skill']:['--help','--version']).includes(args[0]);}
function registeredEnvironment(context,env){
  plainJson(env);
  verifyPrivateSelectors(context.record,env,context.directories);
  requireProof(Object.keys(env).every(key=>context.allowedKeys.has(key)),'Control environment contains an unregistered entry.');
  for(const[key,value]of Object.entries(context.fixtureEnvironment))requireProof(env[key]===value,'Fixture environment changed after registration.');
  requireProof(env.DO_NOT_TRACK==='1'&&env.HERDR_TELEMETRY==='0','Private telemetry selectors changed.');
  for(const [file,proof]of context.binaries)requireProof(stable(binaryProof(file))===stable(proof),'A pinned control executable changed.');
}
function binaryProof(file){const stat=sync.lstatSync(file,{bigint:true});requireProof(stat.isFile()&&!stat.isSymbolicLink()&&sync.realpathSync(file)===file&&(stat.mode&0o111n)!==0n,'A canonical installed executable is required.');return {dev:String(stat.dev),ino:String(stat.ino),uid:String(stat.uid),mode:String(stat.mode),size:String(stat.size),modified:String(stat.mtimeNs)};}
function rawRun(executable,args,{env=process.env,timeout=30000,json=true}={}){
  const result=spawnSync(executable,args,{env,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  if(result.error||result.status!==0){const error=new Error(`${path.basename(executable)} ${args[0]||''}: ${(result.stderr||result.stdout||result.error?.message||'failed').trim().slice(0,1800)}`);error.exitCode=result.status||1;throw error;}
  return json?JSON.parse(result.stdout):result.stdout.trim();
}

export function run(executable, args, { env = process.env, timeout = 30000, json = true } = {}) {
  const kind=controlKind(executable);if(!kind||staticHelp(kind,args))return rawRun(executable,args,{env,timeout,json});
  const context=contexts.get(env?.HC_SESSION);requireProof(context?.active,'Control calls require a registered private context.');
  let event;
  try{
    registeredEnvironment(context,env);
    requireProof(Array.isArray(args)&&args.every(value=>typeof value==='string'&&!value.includes('\0')),'Control arguments are invalid.');
    const optionArgs=args.slice(0,args.includes('--')?args.indexOf('--'):args.length);
    for(const [index,arg]of optionArgs.entries())if(/^--(?:session|socket|home|runtime|config|app-home|connect)(?:=|$)/.test(arg))requireProof(kind==='hc'&&args[0]==='machine'&&args[1]==='add'&&arg==='--session'&&contexts.get(args[index+1])?.active,'Control routing overrides are forbidden.');
    if(kind==='hc'&&args[0]==='server')requireProof(args[1]==='status'||args[1]==='start'&&!context.core||args[1]==='stop'&&context.closing,'Core lifecycle controls require their owned phase.');
    if(context.core)verifyCoreLive(context);
    const command=args[0]==='do'?args[1]:args.slice(0,2).filter(value=>!value.startsWith('--')).join(' ');
    if(!context.core)requireProof(kind==='hc'&&args[0]==='server'&&['start','status'].includes(args[1]),'Core ownership is required before fixture operations.');
    if(kind==='app'&&args[0]!=='check')requireProof(context.app,'App socket ownership is required before IPC.');
    if(kind==='app'&&args[0]==='check')requireProof(canonicalPath(args[1])&&args[1].startsWith(context.record.selectors.HERDR_APP_HOME+'/mods/'),'Native load checks require an owned mod folder.');
    if(kind==='app'&&context.app)verifyAppLive(context);
    event=audit(context,kind,command,{result:'failed'});
    const result=rawRun(kind==='hc'?context.hcBinary:context.appBinary,args,{env,timeout,json});event.result='ok';return result;
  }catch(error){if(error instanceof NativeIsolationError){context.tainted=true;if(!event)audit(context,kind,'ownership refused',{result:'refused'});}throw error;}
}

export async function until(read, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

function plainJson(value,depth=0,budget={nodes:0}){
  requireProof(depth<=24&&++budget.nodes<=200000,'Native evidence exceeds its traversal bound.');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){requireProof(Number.isFinite(value),'Native evidence contains a non-finite number.');return;}
  if(typeof value==='string'){requireProof(Buffer.byteLength(value)<=131072&&!value.includes('\0'),'Native evidence contains an oversized string.');return;}
  requireProof(Array.isArray(value)||plain(value),'Native evidence must contain plain JSON data.');
  if(Array.isArray(value)){requireProof(Object.getPrototypeOf(value)===Array.prototype&&value.length<=50000&&Reflect.ownKeys(value).length===value.length+1,'Native evidence array exceeds its bound or contains non-JSON properties.');const descriptors=Object.getOwnPropertyDescriptors(value);for(let index=0;index<value.length;index++){const d=descriptors[index];requireProof(d&&Object.hasOwn(d,'value'),'Native evidence array contains an accessor or hole.');plainJson(d.value,depth+1,budget);}}
  else{requireProof(Reflect.ownKeys(value).every(key=>typeof key==='string'),'Native evidence contains symbol keys.');for(const d of Object.values(Object.getOwnPropertyDescriptors(value))){requireProof(Object.hasOwn(d,'value'),'Native evidence contains an accessor.');plainJson(d.value,depth+1,budget);}}
}
function processSchema(value,context,completedMs){
  requireProof(exact(value,['pid','uid','startedMs','executable','fingerprint'])&&pid(value.pid)&&value.uid===context.uid&&integer(value.startedMs)&&value.startedMs>=Math.floor(context.createdMs/1000)*1000-2000&&value.startedMs<=completedMs&&canonicalPath(value.executable)&&value.fingerprint===processDigest(value),'Native process generation proof is invalid.');
}
function socketSchema(value,context,process,allowedPids){
  requireProof(exact(value,['path','dev','ino','uid','mode','ownerPids'])&&canonicalPath(value.path)&&value.path.startsWith(context.root+'/')&&decimal(value.dev)&&decimal(value.ino)&&value.uid===context.uid&&integer(value.mode)&&value.mode<=0o777&&Array.isArray(value.ownerPids)&&value.ownerPids.length>0,'Native socket proof is invalid.');
  const owners=[...new Set(value.ownerPids)].sort((a,b)=>a-b);requireProof(stable(owners)===stable(value.ownerPids)&&owners.includes(process.pid)&&owners.every(value=>pid(value)&&allowedPids.includes(value)),'Native listener belongs to an unverified process.');
}
function readReceiptFile(receiptPath){
  requireProof(typeof receiptPath==='string','An actual native receipt path is required.');const file=path.resolve(ROOT,receiptPath),relative=path.relative(ROOT,file);
  requireProof(/^evidence\/native\/[a-z][a-z0-9-]*\.json$/.test(relative)&&sync.realpathSync(file)===file,'Native receipt path must be a canonical evidence file.');
  const stat=sync.lstatSync(file);requireProof(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=16*1024*1024,'Native receipt file is invalid.');const raw=sync.readFileSync(file);return {file,relative,raw,value:JSON.parse(raw)};
}
function validateV2(receipt){
  const rootKeys=['v','ok','code','error','cleanupError','completedMs','nonce','isolation','privateCoreId','privateCorePid','privateHolderPid','appPid','launcherPid','launcherExitCode','assertions','inputActions','frames','appCommands','packages','appErrors','boundary','cleanup','harnessSourceSha256'];
  requireProof(exact(receipt,rootKeys)&&receipt.v===2&&receipt.ok===true&&receipt.code===null&&receipt.error===null&&receipt.cleanupError===null&&integer(receipt.completedMs)&&textValue(receipt.boundary),'Native success envelope is invalid.');
  const current=sha(sync.readFileSync(fileURLToPath(import.meta.url)));requireProof(current===HARNESS_SOURCE_SHA256&&receipt.harnessSourceSha256===current,'Native evidence does not match the current loaded harness.');
  const p=receipt.isolation;requireProof(exact(p,['method','existingInstancesQueried','context','core','app','commandAudit'])&&p.method==='private-ownership-v2'&&p.existingInstancesQueried===false,'Native ownership method is invalid.');
  const context=p.context;contextSchema(context);requireProof(receipt.completedMs>=context.createdMs&&receipt.nonce===context.nonce,'Native context lifetime is invalid.');
  const core=p.core,app=p.app;requireProof(exact(core,['id','process','socket','holder'])&&hex(core.id,32)&&exact(app,['process','socket']),'Native core/app proof is incomplete.');
  processSchema(core.process,context,receipt.completedMs);processSchema(app.process,context,receipt.completedMs);
  const processes=[core.process,app.process];if(core.holder!==null){requireProof(exact(core.holder,['process','socket']),'Native holder proof is invalid.');processSchema(core.holder.process,context,receipt.completedMs);processes.push(core.holder.process);}
  const pids=processes.map(p=>p.pid);requireProof(new Set(pids).size===pids.length,'Native process identities overlap.');
  socketSchema(core.socket,context,core.process,pids);socketSchema(app.socket,context,app.process,pids);if(core.holder)socketSchema(core.holder.socket,context,core.holder.process,pids);
  requireProof(app.socket.path===context.root+'/app/herdr-app.sock'&&receipt.privateCoreId===core.id&&receipt.privateCorePid===core.process.pid&&receipt.privateHolderPid===(core.holder?.process.pid??null)&&receipt.appPid===app.process.pid,'Native top-level identities disagree with ownership proof.');
  requireProof(receipt.launcherPid===null||pid(receipt.launcherPid),'Native launcher identity is invalid.');requireProof(receipt.launcherExitCode===null||Number.isSafeInteger(receipt.launcherExitCode),'Native launcher exit status is invalid.');
  const cleanup=receipt.cleanup;requireProof(exact(cleanup,['attempted','stoppedOnlyOwnedProcesses','existingInstancesQueried','verifiedPrivateCore','verifiedPrivateApp','resourcesRemoved','refused'])&&cleanup.attempted===true&&cleanup.stoppedOnlyOwnedProcesses===true&&cleanup.existingInstancesQueried===false&&cleanup.verifiedPrivateCore===true&&cleanup.verifiedPrivateApp===true&&cleanup.resourcesRemoved===true&&cleanup.refused===false,'Native cleanup is incomplete or unproven.');
  requireProof(Array.isArray(p.commandAudit)&&p.commandAudit.length>0,'Native command routing audit is absent.');let previous=context.createdMs;
  const selectorSha256=sha(stable(context.selectors));for(const[eventIndex,event]of p.commandAudit.entries()){
    requireProof(exact(event,['sequence','at','kind','command','selectorSha256','phase','result'])&&event.sequence===eventIndex+1&&integer(event.at)&&event.at>=previous&&event.at<=receipt.completedMs&&['hc','app'].includes(event.kind)&&textValue(event.command,128)&&event.selectorSha256===selectorSha256&&['boot','owned','cleanup'].includes(event.phase)&&['ok','failed'].includes(event.result),'Native command routing audit is invalid.');previous=event.at;
    if(event.phase==='boot')requireProof(event.kind==='hc'&&['server start','server status'].includes(event.command),'Unowned fixture operation appears in bootstrap.');
  }
  const audited=(kind,command,phase)=>p.commandAudit.some(e=>e.kind===kind&&e.command===command&&e.phase===phase&&e.result==='ok');
  requireProof(audited('hc','server start','boot')&&p.commandAudit.some(e=>e.phase==='owned'&&e.result==='ok')&&audited('hc','verify exit','cleanup')&&audited('app','verify exit','cleanup'),'Native start/control/shutdown audit is incomplete.');
  requireProof(Array.isArray(receipt.assertions)&&receipt.assertions.length>0&&receipt.assertions.every(a=>exact(a,['label','passed'])&&textValue(a.label,1800)&&a.passed===true),'Native assertions are incomplete.');
  for(const key of ['inputActions','frames','appCommands','packages','appErrors'])requireProof(Array.isArray(receipt[key]),'Native evidence array is missing.');requireProof(receipt.appErrors.length===0,'Native app errors cannot release a package.');
  requireProof(receipt.inputActions.some(a=>plain(a)&&['pointer','key','AX'].includes(a.kind)&&a.pid===app.process.pid),'Real PID-bound native input is absent.');
  requireProof(receipt.frames.length>=2,'Before/after native frames are absent.');
  for(const frame of receipt.frames)requireProof(exact(frame,['label','capture','path','sha256','width','height'])&&/^[a-z][a-z0-9-]{0,63}$/.test(frame.label)&&frame.capture==='macos-window-server'&&frame.path===`.browse/sessions/mission-control-native-${context.nonce}/${frame.label}.png`&&hex(frame.sha256)&&Number.isSafeInteger(frame.width)&&frame.width>0&&frame.width<=32768&&Number.isSafeInteger(frame.height)&&frame.height>0&&frame.height<=32768,'Native frame metadata is invalid.');
  requireProof(new Set(receipt.frames.map(f=>f.sha256)).size>=2,'Native before/after frames did not change.');
}

export async function validateNativeIsolationReceipt(receipt,options={}){
  try{
    plainJson(options);requireProof(plain(options)&&Reflect.ownKeys(options).every(key=>key==='receiptPath'),'Native receipt options are invalid.');plainJson(receipt);requireProof(Buffer.byteLength(JSON.stringify(receipt))<=16*1024*1024,'Native receipt is oversized.');
    const source=Object.hasOwn(options,'receiptPath')?readReceiptFile(options.receiptPath):null;if(source)requireProof(stable(source.value)===stable(receipt),'Native packet differs from its actual file.');
    if(receipt?.v===2){validateV2(receipt);return true;}
    requireProof(receipt?.v===1&&receipt.ok===true&&source,'Unknown or failed native receipt cannot release a package.');const pin=legacyPins.find(p=>p.path===source.relative);
    requireProof(pin&&sha(source.raw)===pin.sha256&&receipt.harnessSourceSha256===pin.harnessSourceSha256,'Legacy native proof is not an immutable retained observation.');
    requireProof(hex(receipt.baselineCoreSha256)&&receipt.isolation?.distinctCore===true&&receipt.isolation?.distinctProcess===true&&receipt.cleanup?.userCoreIdentityAndPidUnchanged===true&&receipt.cleanup?.stoppedOnlyOwnedProcesses===true&&Array.isArray(receipt.appErrors)&&receipt.appErrors.length===0,'Pinned legacy native proof is incomplete.');return true;
  }catch(error){if(error instanceof NativeIsolationError)throw error;throw new NativeIsolationError('Native receipt could not be verified.');}
}

function appBinary(env) {
  const located = run('which', ['herdr-app'], { env,json: false });
  return fs.realpath(located);
}

const observationEnv={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',TZ:'UTC'};
function observeProcess(address,{missing=false}={}){
  requireProof(pid(address),'A recorded process identity is required.');
  const r=spawnSync('/bin/ps',['-p',String(address),'-o','uid=','-o','lstart=','-o','comm='],{env:observationEnv,encoding:'utf8',timeout:5000,maxBuffer:65536});
  if(r.status===1&&!r.error&&!r.stdout.trim()&&missing)return null;
  requireProof(!r.error&&r.status===0,'The recorded private process is unavailable.');
  const match=r.stdout.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  requireProof(match,'The private process observation is invalid.');
  const value={pid:address,uid:Number(match[1]),startedMs:Date.parse(match[2]+' UTC'),executable:sync.realpathSync(match[3].trim())};value.fingerprint=processDigest(value);requireProof(integer(value.startedMs),'The private process start time is unavailable.');return value;
}
function sameProcess(expected,{missing=false}={}){const actual=observeProcess(expected.pid,{missing});if(!actual)return false;requireProof(stable(actual)===stable(expected),'The recorded private process generation changed.');return true;}
function observeSocket(context,file){
  requireProof(canonicalPath(file)&&file.startsWith(context.record.root+'/')&&sync.realpathSync(file)===file,'Private listener path escaped its context.');
  const s=sync.lstatSync(file,{bigint:true});requireProof(s.isSocket()&&!s.isSymbolicLink()&&Number(s.uid)===context.record.uid,'Private listener ownership is unavailable.');
  const r=spawnSync('/usr/sbin/lsof',['-nP','-U','-t','-a','--',file],{env:observationEnv,encoding:'utf8',timeout:10000,maxBuffer:65536});
  requireProof(!r.error&&[0,1].includes(r.status),'Private listener owner could not be inspected.');
  const owners=[...new Set(r.stdout.trim().split(/\s+/).filter(Boolean).map(Number))].sort((a,b)=>a-b);requireProof(owners.length&&owners.every(pid),'Private listener has no proven process owner.');
  return {path:file,dev:s.dev.toString(),ino:s.ino.toString(),uid:Number(s.uid),mode:Number(s.mode&0o777n),ownerPids:owners};
}
function privateSockets(context){
  const paths=[],queue=[context.record.root];let count=0;
  while(queue.length){const directory=queue.shift();for(const item of sync.readdirSync(directory,{withFileTypes:true})){requireProof(++count<=20000,'Private listener discovery exceeds its bound.');const file=path.join(directory,item.name);if(item.isSymbolicLink())continue;if(item.isDirectory())queue.push(file);else if(item.isSocket())paths.push(file);}}
  return paths.sort();
}
function processSocketProof(context,address){
  const process=observeProcess(address);processSchema(process,context.record,Date.now());
  for(const file of privateSockets(context)){const socket=observeSocket(context,file);if(socket.ownerPids.includes(address))return {process,socket};}
  invalid('No task-owned Unix listener proves the reported private process.');
}
function audit(context,kind,command,{phase=context.closing?'cleanup':context.core?'owned':'boot',result='ok'}={}){
  const event={sequence:context.audit.length+1,at:Date.now(),kind,command,selectorSha256:sha(stable(context.record.selectors)),phase,result};context.audit.push(event);return event;
}
function readOwnedStatus(context){
  registeredEnvironment(context,context.env);const event=audit(context,'hc','server status',{result:'failed'});const value=rawRun(context.hcBinary,['server','status','--json'],{env:context.env});event.result='ok';return value;
}
// Helpers the verified app or core spawns can inherit its listener; a live descendant belongs to that owned tree.
function descendsFrom(address,allowed){
  for(let current=address,steps=0;pid(current)&&steps<32;steps++){
    const r=spawnSync('/bin/ps',['-o','ppid=','-p',String(current)],{env:observationEnv,encoding:'utf8',timeout:5000,maxBuffer:65536});
    current=Number(r.stdout.trim());if(allowed.includes(current))return true;
  }
  return false;
}
const alive=address=>spawnSync('/bin/ps',['-p',String(address)],{env:observationEnv,timeout:5000}).status===0;
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function sameSocket(context,expected,process){
  const allowed=[context.core?.process.pid,context.core?.holder?.process.pid,context.app?.process.pid].filter(pid);
  // A short-lived helper can hold the inherited listener for an instant: an exited holder owns nothing, and a
  // live one is re-checked briefly. Any live process outside the owned tree still refuses.
  let actual,strangers;
  for(let attempt=0;attempt<4;attempt++){
    if(attempt)pause(250);
    actual=observeSocket(context,expected.path);for(const key of ['path','dev','ino','uid','mode'])requireProof(actual[key]===expected[key],'The private listener generation changed.');
    actual.ownerPids=actual.ownerPids.filter(owner=>allowed.includes(owner)||alive(owner)&&!descendsFrom(owner,allowed));
    strangers=actual.ownerPids.filter(owner=>!allowed.includes(owner));if(!strangers.length)break;
  }
  requireProof(!strangers.length,'Native listener belongs to an unverified process: '+strangers.map(owner=>owner+' '+String(spawnSync('/bin/ps',['-o','command=','-p',String(owner)],{env:observationEnv,encoding:'utf8',timeout:5000}).stdout).trim().slice(0,120)).join('; '));
  socketSchema(actual,context.record,process,allowed);return actual;
}
function captureCore(context,status){
  requireProof(hex(status?.core?.id,32)&&pid(status.pid),'The private core did not report a valid identity.');
  const owned=processSocketProof(context,status.pid);context.core={id:status.core.id,...owned,holder:null};
  if(pid(status.holder?.pid))context.core.holder=processSocketProof(context,status.holder.pid);
  const allowed=[context.core.process.pid,context.core.holder?.process.pid].filter(pid);socketSchema(context.core.socket,context.record,context.core.process,allowed);if(context.core.holder)socketSchema(context.core.holder.socket,context.record,context.core.holder.process,allowed);
  context.lastStatus=status;return context.core;
}
function verifyCoreLive(context){
  requireProof(context.core&&!context.tainted,'Private core ownership is not established.');sameProcess(context.core.process);
  const socket=observeSocket(context,context.core.socket.path);for(const key of ['path','dev','ino','uid','mode'])requireProof(socket[key]===context.core.socket[key],'The private listener generation changed.');requireProof(socket.ownerPids.includes(context.core.process.pid),'The original core no longer owns its listener.');
  const status=readOwnedStatus(context);requireProof(status.core?.id===context.core.id&&status.pid===context.core.process.pid,'Private core identity changed.');
  if(pid(status.holder?.pid)&&!context.core.holder)context.core.holder=processSocketProof(context,status.holder.pid);
  requireProof((status.holder?.pid??null)===(context.core.holder?.process.pid??null),'Private holder identity changed.');
  context.core.socket=sameSocket(context,context.core.socket,context.core.process);
  if(context.core.holder){sameProcess(context.core.holder.process);context.core.holder.socket=sameSocket(context,context.core.holder.socket,context.core.holder.process);}context.lastStatus=status;
}
function verifyAppLive(context){requireProof(context.app&&!context.appExited,'Private app ownership is not established.');sameProcess(context.app.process);context.app.socket=sameSocket(context,context.app.socket,context.app.process);}
async function finishProcess(context,targetProcess,kind){
  const end=Date.now()+5000;while(sameProcess(targetProcess,{missing:true})&&Date.now()<end)await delay(100);
  if(sameProcess(targetProcess,{missing:true})){
    registeredEnvironment(context,context.env);
    process.kill(targetProcess.pid,'SIGTERM');
    await until(()=>!sameProcess(targetProcess,{missing:true}),'recorded private process exit',8000);
  }
  audit(context,kind,'verify exit',{phase:'cleanup'});
}

const PROBE_MOD = `import {View,div} from "gpui-kit";
import {v_flex} from "gpui-base";
import {shared,setShared} from "herdr";
const key="mission-control-isolation-clicks";
export default class Probe extends View {
  init(){setShared(key,0);}
  render(){return div().size_full().bg("#101114").flex().items_center().justify_center().child(
    v_flex().w(240).gap(16).child(div().h(24).text_size(16).text_color("#d8dbe2").child("Isolated native Herdr"))
      .child(div().id("isolation-increment").h(44).w_full().rounded(6).bg("#253044").text_color("#e5e9f0")
        .flex().items_center().justify_center().on_click((_e,cx)=>{setShared(key,(shared(key)??0)+1);cx.notify();})
        .child("Clicks: "+(shared(key)??0))));}
}
`;

export class NativeRuntime {
  constructor() { this.assertions = []; this.frames = []; this.processes = []; this.packages = []; this.appCommands = []; this.closed = false; this.lastAppErrors=[]; this.cleanup={attempted:false,stoppedOnlyOwnedProcesses:false,existingInstancesQueried:false,verifiedPrivateCore:false,verifiedPrivateApp:false,resourcesRemoved:false,refused:false}; }

  hc(args, options = {}) {requireProof(this.context?.active,'Private runtime has not started.');const env=options.env??this.env;requireProof(env.HC_SESSION===this.context.record.session,'A runtime cannot use another context.');return run('hc', args, { ...options,env }); }
  app(args, options = {}) {
    requireProof(this.context?.active,'Private runtime has not started.');const env=options.env??this.env;requireProof(env.HC_SESSION===this.context.record.session,'A runtime cannot use another context.');
    if (args[0] === 'do') {
      let keys = []; try { keys = Object.keys(JSON.parse(args[2] || '{}')).sort(); } catch {}
      this.appCommands.push({ kind: 'setup-or-service-command', command: args[1], argumentKeys: keys });
    }
    return run(this.binary, args, { ...options,env });
  }
  expect(value, label) {
    if (!value) throw new Error(`Native assertion failed: ${label}`);
    this.assertions.push({ label, passed: true });
  }

  async start({fixtureEnvironment={}}={}) {
    requireProof(!this.directory&&!this.closed,'A private runtime cannot be reused.');validateFixtureEnvironment(fixtureEnvironment);
    this.directory = await fs.mkdtemp('/private/tmp/mcqa-');
    this.nonce = crypto.randomBytes(12).toString('hex');this.rootDirectory=directoryProof(this.directory);
    this.env = isolatedEnvironment(this.directory, this.nonce,process.env,fixtureEnvironment);
    for (const directory of new Set(Object.keys(selectorSuffixes).map(key=>this.env[key]))) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    this.binary = await appBinary(this.env);
    const selectors=contextSelectors(this.directory,this.nonce),record=freeze({root:this.directory,nonce:this.nonce,session:this.env.HC_SESSION,uid:this.rootDirectory.uid,createdMs:this.rootDirectory.birthMs,directory:this.rootDirectory,selectors});
    const hcBinary=sync.realpathSync(rawRun('which',['hc'],{env:this.env,json:false}));requireProof(!contexts.has(record.session),'Private context namespace was already registered.');
    this.context={record,env:this.env,fixtureEnvironment:freeze(validateFixtureEnvironment(fixtureEnvironment,this.directory)),allowedKeys:new Set(Object.keys(this.env)),directories:freeze(Object.fromEntries([...new Set(Object.keys(selectorSuffixes).map(key=>this.env[key]))].map(file=>[file,directoryProof(file)]))),binaries:new Map([hcBinary,this.binary].map(file=>[file,freeze(binaryProof(file))])),hcBinary,appBinary:this.binary,core:null,app:null,audit:[],active:true,closing:false,tainted:false,appExited:false};
    verifyPrivateSelectors(record,this.env,this.context.directories);contexts.set(record.session,this.context);this.context.startAttempted=true;
    this.hc(['server', 'start', '--json']);
    this.own = this.hc(['server', 'status', '--json']);
    captureCore(this.context,this.own);
    this.expect(this.own.live === 0 && this.own.finished === 0, 'Fresh positively verified private core starts empty');
    this.repo = await this.createRepo('fixture-repo');
    this.spaceId = `qa-sp-${this.nonce}`;
    this.tabId = `qa-tab-${this.nonce}`;
    this.hc(['run', '--bg', '--no-parent', '--label', `mission-control.qa=${this.nonce}`, '--label', `herdr.space=${this.spaceId}`,
      '--label', `herdr.tab=${this.tabId}`, '--cwd', this.repo, '--', 'python3', '-u', '-c', 'import time; print("Mission Control isolated sentinel",flush=True); time.sleep(3600)']);
    const own = this.hc(['ls', '--json', '--label', `mission-control.qa=${this.nonce}`]);
    this.expect(own.terminals?.length === 1, 'Exact nonce sentinel belongs to the verified private core');
    this.sentinel = own.terminals[0].address;
    const full = this.hc(['get', this.sentinel, '--json']);
    this.expect(full.labels?.['mission-control.qa'] === this.nonce && Number.isSafeInteger(full.created_ms)&&full.created_ms>=this.context.record.createdMs, 'Full sentinel generation and QA ownership verified');
    return this;
  }

  async createRepo(name) {
    requireProof(this.context?.core,'Private core ownership is required before fixture mutations.');registeredEnvironment(this.context,this.env);verifyCoreLive(this.context);
    if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new Error('Invalid fixture repository name');
    const directory = path.join(this.directory, name);
    await fs.mkdir(directory);
    run('git', ['-C', directory, 'init', '-q', '-b', 'main'], { env: this.env, json: false });
    run('git', ['-C', directory, 'config', 'user.name', 'Mission Control QA'], { env: this.env, json: false });
    run('git', ['-C', directory, 'config', 'user.email', 'qa@example.invalid'], { env: this.env, json: false });
    run('git', ['-C', directory, 'config', 'commit.gpgsign', 'false'], { env: this.env, json: false });
    await fs.writeFile(path.join(directory, 'README.md'), '# Disposable native fixture\n');
    run('git', ['-C', directory, 'add', 'README.md'], { env: this.env, json: false });
    run('git', ['-C', directory, 'commit', '-qm', 'Create fixture'], { env: this.env, json: false });
    return directory;
  }

  async installPackage(name) {
    const built = await buildPackage(name);
    const target = path.join(this.env.HERDR_APP_HOME, 'mods', name);
    if (await exists(target)) throw new Error('Refusing to overwrite a mod in the test home');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(built.directory, target, { recursive: true });
    this.app(['check', target], { json: false });
    this.packages.push({ name, nativeCheck: true, manifest: built.manifest });
    return built.manifest;
  }

  async startWindow({ layout, name = 'isolation-probe' } = {}) {
    const home = this.env.HERDR_APP_HOME;
    await fs.mkdir(path.join(home, 'mods'), { recursive: true });
    await fs.mkdir(path.join(home, 'layouts'), { recursive: true });
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ zoom: 1, font_size: 12, telemetry: false }) + '\n');
    // Fixture setup only: the shipped welcome screen uses this exact persisted
    // completion key. A fresh test home otherwise covers every mounted mod.
    await fs.writeFile(path.join(home, 'shared.json'), JSON.stringify({ 'frame.welcomed': 'finished' }) + '\n');
    // Record this exact app version as already run, so a fresh test home never
    // shows the post-update pill or treats the launch as the first start after an update.
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(run(this.binary, ['--version'], { env: this.env, json: false }))?.[1];
    if (!version) throw new Error('The private Herdr version is unavailable');
    await fs.writeFile(path.join(home, 'update-notes.json'), JSON.stringify({ last_run: version, presented: [] }) + '\n');
    const selectedLayout = `mission-control-${name}`;
    if(!await exists(path.join(home,'window.json')))await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[300,350,1280,760]})+'\n');
    if (!layout) {
      const mod = path.join(home, 'mods/mission-control-isolation-probe');
      await fs.mkdir(mod);
      await fs.writeFile(path.join(mod, 'main.js'), PROBE_MOD);
      await fs.writeFile(path.join(mod, 'mod.json'), '{"title":"Isolation probe","place":"none"}\n');
      this.app(['check', mod], { json: false });
      layout = { id: 'qa-root', type: 'block', titlebar: 'none', traffic_lights: [12, 16], content: { mod: 'mission-control-isolation-probe' } };
    }
    await fs.writeFile(path.join(home, 'layouts', selectedLayout + '.json'), JSON.stringify(layout, null, 2) + '\n');
    registeredEnvironment(this.context,this.env);verifyCoreLive(this.context);
    this.child = spawn(this.binary, [], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.appStderr = '';
    this.appStdout = '';
    this.child.stderr.on('data', bytes => { this.appStderr = (this.appStderr + bytes.toString()).slice(-4000); });
    this.child.stdout.on('data', bytes => { this.appStdout = (this.appStdout + bytes.toString()).slice(-4000); });
    try {this.launcherProof=observeProcess(this.child.pid);processSchema(this.launcherProof,this.context.record,Date.now());}catch{ /* A detached launcher may have already exited. */ }
    const endpoint=path.join(home,'herdr-app.sock');await until(()=>exists(endpoint),'new private Herdr listener',40000);
    this.owner = await registerOwnedSocketProcess({ directory: this.directory, socket: endpoint });
    const process=observeProcess(this.owner.pid);processSchema(process,this.context.record,Date.now());const socket=observeSocket(this.context,endpoint);this.context.app={process,socket};verifyAppLive(this.context);
    this.driver = new NativeDriver(this.owner);
    await until(() => this.app(['status']), 'verified private Herdr IPC', 40000);
    await until(() => JSON.stringify(this.app(['ls'])).includes(this.spaceId), 'private sentinel adoption in the actual window');
    const refreshed = this.hc(['server', 'status', '--json']);
    this.expect(refreshed.core.id === this.context.core.id&&refreshed.pid===this.context.core.process.pid, 'Private app uses the original verified core generation');
    this.own = refreshed;
    this.app(['do', 'layout.switch', JSON.stringify({ name: selectedLayout })]);
    await until(() => this.app(['status']).layout === selectedLayout, 'private layout selection');
    this.expect(this.app(['status']).errors?.length === 0, 'No native layout/mod errors');
    return this;
  }

  async shared() {
    try { return JSON.parse(await fs.readFile(path.join(this.env.HERDR_APP_HOME, 'shared.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async frame(label) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) throw new Error('Invalid frame label');
    const directory = path.join(ROOT, '.browse/sessions', `mission-control-native-${this.nonce}`);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, label + '.png');
    // Capture the actual displayed window. Herdr 0.1.10's offscreen `shot`
    // can omit cached content after reopening a mod; a WindowServer capture
    // includes what the user sees and is bound to this verified owned PID.
    if (!this.driver) throw new Error('A verified native window is required for capture');
    await this.driver.bridge('screenshot', file);
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Herdr did not produce a PNG frame');
    const result = { label, capture: 'macos-window-server', path: path.relative(ROOT, file), sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    this.frames.push(result);
    return result;
  }

  async probe() {
    await this.start();
    await this.startWindow();
    await until(async () => (await this.shared())['mission-control-isolation-clicks'] === 0, 'rendered GPUI probe initialization');
    const before = await this.frame('isolation-before');
    const { frame } = await this.driver.pointerTarget({ x: 1, y: 1, width: 2, height: 2 });
    await this.driver.click({ x: frame.width / 2 - 100, y: frame.height / 2 + 4, width: 200, height: 32 }, { expectedSize: frame });
    await until(async () => (await this.shared())['mission-control-isolation-clicks'] === 1, 'real GPUI pointer handler/shared-state result');
    await delay(200);
    const after = await this.frame('isolation-after');
    this.expect(before.sha256 !== after.sha256, 'Actual native frame changes after the GPUI click');
    verifyCoreLive(this.context);
  }

  receipt(ok, error, cleanupError) {
    const context=this.context;
    return { v: 2, ok, code:ok?null:error?.code||'NATIVE_RUN_FAILED', error:ok?null:(error?.message||'Native verification failed.').slice(0,1800), cleanupError:cleanupError?.message?.slice(0,1800)??null, completedMs:Date.now(), nonce: this.nonce??null,
      isolation: context?structuredClone({method:'private-ownership-v2',existingInstancesQueried:false,context:context.record,core:context.core,app:context.app,commandAudit:context.audit}):null,
      privateCoreId: context?.core?.id??null, privateCorePid: context?.core?.process.pid??null, privateHolderPid: context?.core?.holder?.process.pid??null,
      appPid:context?.app?.process.pid??null, launcherPid: this.child?.pid??null, launcherExitCode: this.child?.exitCode??null,
      assertions: this.assertions, inputActions: this.driver?.actions || [], frames: this.frames,
      appCommands: this.appCommands, packages: this.packages,
      appErrors:this.lastAppErrors,cleanup:{...this.cleanup},harnessSourceSha256:HARNESS_SOURCE_SHA256,
      boundary: 'Task-owned GPUI app/core with PID-bound native input. Existing instances were not queried. Provider authentication is not proven.' };
  }

  async close() {
    if (this.closed) return;
    if(this.closeError)throw this.closeError;
    this.cleanup.attempted=true;const context=this.context;
    try{
      requireProof(context&&!context.tainted,'Cleanup requires the original proven private context.');
      registeredEnvironment(context,this.env);requireProof(context.core,'An unproven started core cannot be stopped or removed.');verifyCoreLive(context);
      requireProof(!this.child||context.app,'An unproven app cannot be stopped or removed.');
      if(context.app)verifyAppLive(context);
      context.closing=true;
      if(context.app){
        try{this.lastAppErrors=this.app(['status']).errors??[];}catch(error){if(error instanceof NativeIsolationError)throw error;this.lastAppErrors=[{code:'STATUS_UNAVAILABLE'}];}
        try{this.app(['do','app.quit']);}catch(error){if(error instanceof NativeIsolationError)throw error;}
        await finishProcess(context,context.app.process,'app');context.appExited=true;this.cleanup.verifiedPrivateApp=true;
      }
      if(this.child?.pid!==context.app?.process.pid&&this.child?.exitCode===null){requireProof(this.launcherProof,'The launcher generation is unavailable.');await finishProcess(context,this.launcherProof,'app');}
      try{this.hc(['server','stop','--json']);}catch(error){if(error instanceof NativeIsolationError)throw error;}
      await finishProcess(context,context.core.process,'hc');
      if(context.core.holder)await finishProcess(context,context.core.holder.process,'hc');
      this.cleanup.verifiedPrivateCore=true;this.cleanup.stoppedOnlyOwnedProcesses=true;
      registeredEnvironment(context,this.env);await fs.rm(context.record.root,{recursive:true});this.cleanup.resourcesRemoved=true;
      context.active=false;contexts.delete(context.record.session);this.closed=true;
    }catch(error){this.cleanup.refused=true;if(context)context.tainted=true;this.closeError=error;throw error;}
  }
}

/** Local TLS and real MCP protocol services; dataset/response ownership stays in each scenario. */
export async function createFixtureService(directory, { handler = () => ({ status: 404, body: { error: 'No fixture route' } }), tools = [] } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const key = path.join(directory, 'fixture.key'), cert = path.join(directory, 'fixture.pem');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=mission-control-fixture-'+crypto.randomBytes(12).toString('hex'),
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert], { json: false });
  await fs.chmod(key, 0o600);
  const transports = new Map();
  const requests = [];
  const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (req, res) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new Error('Fixture request exceeds 64 KiB'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: req.url, hasAuthorization: Boolean(req.headers.authorization) });
      if (req.url === '/mcp') {
        const id = req.headers['mcp-session-id'];
        let transport = typeof id === 'string' ? transports.get(id) : null;
        if (!transport && !id && isInitializeRequest(body)) {
          const mcp = new Server({ name: 'mission-control-native-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ handler, ...tool }) => tool) }));
          mcp.setRequestHandler(CallToolRequestSchema, async request => {
            const tool = tools.find(t => t.name === request.params.name);
            if (!tool) return { isError: true, content: [{ type: 'text', text: 'Unknown fixture tool' }] };
            return tool.handler(request.params.arguments ?? {});
          });
          transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: session => transports.set(session, transport) });
          transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
          await mcp.connect(transport);
        }
        if (!transport) { res.writeHead(400).end('Unknown MCP fixture session'); return; }
        await transport.handleRequest(req, res, body);
        return;
      }
      const response = await handler({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(response.status ?? 200, { 'content-type': 'application/json', ...response.headers });
      res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return { origin: `https://127.0.0.1:${server.address().port}`, caFile: cert, requests,
    close: async () => { for (const transport of transports.values()) await transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function importNativeScenario(file){
  const before={...process.env};let module,failure;
  try{module=await import(pathToFileURL(file).href);}catch(error){failure=error;}
  const changed=stable(before)!==stable({...process.env});
  if(changed){for(const key of Object.keys(process.env))if(!Object.hasOwn(before,key))delete process.env[key];Object.assign(process.env,before);invalid('Scenario changed the parent environment before private startup.');}
  if(failure)throw failure;
  requireProof(typeof module.default==='function','Native scenario must export an executable flow.');
  return {execute:module.default,fixtureEnvironment:validateFixtureEnvironment(module.fixtureEnvironment??{})};
}

async function main(args) {
  const scenario = args[0] === 'probe' ? 'isolation' : args[0] === 'run' ? args[1] : null;
  if (!scenario || !/^[a-z][a-z0-9-]*$/.test(scenario)) throw new Error('Usage: node scripts/native-harness.mjs probe | run <scenario>');
  const runtime = new NativeRuntime();
  let receipt, failure,cleanupError;
  try {
    if (scenario === 'isolation') await runtime.probe();
    else {
      const file = path.join(ROOT, 'tests/native', scenario + '.mjs');
      if (!await exists(file)) throw new Error('Native scenario is not implemented: ' + scenario);
      const scenarioModule = await importNativeScenario(file);
      await runtime.start({fixtureEnvironment:scenarioModule.fixtureEnvironment});
      await scenarioModule.execute(runtime);
      runtime.expect(runtime.driver?.actions?.length > 0 && runtime.frames.length > 0, 'Scenario used real native input and captured a native frame');
    }
  } catch (error) { failure = error; }
  finally {
    try { if (runtime.directory) await runtime.close(); }
    catch (error) { failure ||= error;cleanupError=error; }
  }
  receipt=runtime.receipt(!failure,failure,cleanupError);
  if(!failure){try{await validateNativeIsolationReceipt(receipt);}catch(error){failure=error;receipt=runtime.receipt(false,error,cleanupError);}}
  await fs.mkdir(path.join(ROOT, 'evidence/native'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'evidence/native', scenario + '.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (failure || !receipt.ok) process.exitCode = 1;
  // A refused cleanup leaves the private app running; detach so this process exits instead of waiting on its pipes.
  if (runtime.cleanup.refused && runtime.child) { runtime.child.stdout?.destroy(); runtime.child.stderr?.destroy(); runtime.child.unref(); console.error('Private resources left for manual cleanup under ' + runtime.directory); }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
