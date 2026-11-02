import {installedTools,validateToolOptions} from './launch-preferences.js';
import {machineIdentity} from './session-identity.js';
export class CapabilityError extends Error {constructor(code,message){super(message);this.name='CapabilityError';this.code=code;}}
const fail=(code,message)=>{throw new CapabilityError(code,message);};
const has=(help,flag)=>new RegExp(`(?:^|\\n)\\s*(?:-[A-Za-z],\\s*)?${flag.replaceAll('-','\\-')}(?=\\s|[=<]|$)`,'m').test(help);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprint=value=>{let n=2166136261;for(let i=0;i<value.length;i++)n=Math.imul(n^value.charCodeAt(i),16777619);return (n>>>0).toString(16).padStart(8,'0');};
export function parseCapabilities(tool,{on=null,help='',resumeHelp='',version='unavailable',probeError=null}={}){
  if(!installedTools([tool]).length)fail('TOOL_UNAVAILABLE','The selected tool is not installed on this machine');
  const machine=machineIdentity(on),provider=tool.key==='claude'&&/Claude Code/.test(help)?'claude':tool.key==='codex'&&/Codex CLI/.test(help)?'codex':tool.key==='grok'&&/Grok Build TUI/.test(help)?'grok':null;
  const result={v:1,key:tool.key,machine,run:[...tool.run],version:String(version).slice(0,256),provider,base:true,model:null,reasoning:null,resume:null,callerSession:null,foregroundFlag:null,instructions:null,subagents:null,skill:false,prompt:false,probeError};
  if(provider){
    result.model=has(help,'--model')?'--model':null;
    result.prompt=/\[(?:PROMPT|prompt)\]/.test(help);
    if(provider==='claude'){
      result.reasoning=has(help,'--effort')?{flag:'--effort',values:['low','medium','high','xhigh','max'].filter(v=>new RegExp(`\\b${v}\\b`).test(help.slice(help.indexOf('--effort'),help.indexOf('--effort')+250)))}:null;
      result.resume=has(help,'--resume')?{kind:'flag',flag:'--resume'}:null;
      result.callerSession=has(help,'--session-id')?'--session-id':null;
      result.instructions=has(help,'--append-system-prompt')?'--append-system-prompt':null;
    }else if(provider==='codex'){
      result.resume=/Usage:\s*codex resume[\s\S]*\[SESSION_ID\]/.test(resumeHelp)?{kind:'command',command:'resume'}:null;
      result.foregroundFlag=has(help,'--no-daemon')?'--no-daemon':null;
    }else{
      result.resume=has(help,'--resume')?{kind:'flag',flag:'--resume'}:null;
      result.callerSession=has(help,'--session-id')?'--session-id':null;
      result.reasoning=has(help,'--reasoning-effort')?{flag:'--reasoning-effort',values:null}:null;
      result.instructions=has(help,'--rules')?'--rules':null;
      result.subagents=has(help,'--no-subagents')?{disable:'--no-subagents'}:null;
    }
  }
  result.cacheKey=JSON.stringify([machine,tool.key,tool.run,result.version,fingerprint(help+'\n'+resumeHelp)]);
  return result;
}
export async function probeCapabilities(tool,{on=null,exec}={}){
  if(!installedTools([tool]).length)fail('TOOL_UNAVAILABLE','The selected tool is not installed on this machine');
  const call=async flags=>{try{const r=await exec(tool.run[0],[...tool.run.slice(1),...flags],{on:machineIdentity(on)});return r.code===0&&typeof r.stdout==='string'?r.stdout.slice(0,65536):'';}catch{return '';}};
  const help=await call(['--help']),version=(await call(['--version'])).trim();
  const resumeHelp=tool.key==='codex'&&/Codex CLI/.test(help)?await call(['resume','--help']):'';
  return parseCapabilities(tool,{on,help,resumeHelp,version:version||'unavailable',probeError:help?null:'Advanced options unavailable: direct help probing failed. Base configured launch is available.'});
}
export function buildArguments(capabilities,{options={},resumeSessionId,newSessionId,prompt}={}){
  if(!capabilities?.base||!Array.isArray(capabilities.run)||!capabilities.run.length)fail('TOOL_UNAVAILABLE','No installed launch command');
  const requested=validateToolOptions(options),argv=[...capabilities.run];
  if(resumeSessionId&&newSessionId)fail('INVALID_OPTIONS','Resume and new session ID are mutually exclusive');
  const requireOption=(enabled,name)=>{if(!enabled)fail('UNSUPPORTED_OPTION',`${name} is unavailable for this installed tool/version`);};
  if(capabilities.foregroundFlag)argv.push(capabilities.foregroundFlag);
  if(resumeSessionId){
    requireOption(capabilities.resume,'Exact session resume');if(!uuid.test(resumeSessionId))fail('INVALID_SESSION','Resume requires an exact provider session UUID');
    if(capabilities.resume.kind==='command')argv.push(capabilities.resume.command,resumeSessionId);else argv.push(capabilities.resume.flag,resumeSessionId);
  }
  if(newSessionId){requireOption(capabilities.callerSession,'Caller-assigned session ID');if(!uuid.test(newSessionId))fail('INVALID_SESSION','A valid provider session UUID is required');argv.push(capabilities.callerSession,newSessionId);}
  if(requested.model){requireOption(capabilities.model,'Model selection');argv.push(capabilities.model,requested.model);}
  if(requested.reasoning){requireOption(capabilities.reasoning,'Reasoning selection');const r=capabilities.reasoning;if(r.values&&!r.values.includes(requested.reasoning))fail('UNSUPPORTED_OPTION','Unsupported reasoning value');argv.push(r.flag,requested.reasoning);}
  if(requested.instructions){requireOption(capabilities.instructions,'Custom instructions');argv.push(capabilities.instructions,requested.instructions);}
  if(requested.skill)fail('UNSUPPORTED_OPTION','This tool has no verified command-line skill selector');
  if(requested.subagents!==undefined){requireOption(capabilities.subagents,'Subagent selection');if(!requested.subagents)argv.push(capabilities.subagents.disable);}
  if(prompt!==undefined){requireOption(capabilities.prompt,'Initial prompt');if(typeof prompt!=='string'||prompt.includes('\0')||prompt.length>64000)fail('INVALID_OPTIONS','Invalid task text');argv.push('--',prompt);}
  return argv;
}
export class CapabilityRegistry {
  constructor(exec,{clock=()=>Date.now(),ttl=60000}={}){this.exec=exec;this.clock=clock;this.ttl=ttl;this.cache=new Map();}
  async get(tool,on=null){
    if(!installedTools([tool]).length)fail('TOOL_UNAVAILABLE','The selected tool is no longer installed');
    const key=JSON.stringify([machineIdentity(on),tool.key,tool.run]),saved=this.cache.get(key);
    if(saved&&saved.expires>this.clock())return saved.value;
    const value=await probeCapabilities(tool,{on,exec:this.exec});this.cache.set(key,{expires:this.clock()+this.ttl,value});return value;
  }
  clear(){this.cache.clear();}
}
