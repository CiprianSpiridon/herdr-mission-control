import {ConfigError,updateConfig} from './config.js';
const key=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const fail=message=>{throw new ConfigError('INVALID_LAUNCH_PREFERENCES',message);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const bounded=(v,name,max=512)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))fail(`Invalid ${name}`);return v;};
export function validateToolOptions(value={}){
  if(!object(value))fail('Tool options must be an object');
  for(const name of Object.keys(value))if(!['model','reasoning','instructions','skill','subagents'].includes(name))fail(`Unsupported tool option: ${name}`);
  const result={};
  if(value.model!==undefined)result.model=bounded(value.model,'model',256);
  if(value.reasoning!==undefined)result.reasoning=bounded(value.reasoning,'reasoning',32);
  if(value.instructions!==undefined){if(typeof value.instructions!=='string'||value.instructions.length>16000||value.instructions.includes('\0'))fail('Invalid instructions');result.instructions=value.instructions;}
  if(value.skill!==undefined)result.skill=bounded(value.skill,'skill',128);
  if(value.subagents!==undefined){if(typeof value.subagents!=='boolean')fail('Subagent preference must be boolean');result.subagents=value.subagents;}
  return result;
}
export function validateLaunchPreferences(value={}){
  if(!object(value))fail('Launch preferences must be an object');
  const result={v:1,pins:null,hidden:[],worktree:true,tools:{}};
  if(value.v!==undefined&&value.v!==1)fail('Unsupported launch preference version');
  for(const field of ['pins','hidden'])if(value[field]!==undefined&&value[field]!==null){
    if(!Array.isArray(value[field])||value[field].some(v=>typeof v!=='string'||!key.test(v))||new Set(value[field]).size!==value[field].length)fail(`Invalid ${field}`);
    if(field==='pins'&&value[field].length>3)fail('Pin at most three tools');
    result[field]=[...value[field]];
  }
  if(value.worktree!==undefined){if(typeof value.worktree!=='boolean')fail('Worktree preference must be boolean');result.worktree=value.worktree;}
  if(value.tools!==undefined){if(!object(value.tools))fail('Tool preferences must be an object');for(const [name,options]of Object.entries(value.tools)){if(!key.test(name))fail('Invalid tool key');result.tools[name]=validateToolOptions(options);}}
  return result;
}
export function installedTools(tools){
  const seen=new Set();return tools.filter(tool=>tool?.installed===true&&key.test(tool.key)&&Array.isArray(tool.run)&&tool.run.length&&tool.run.every(v=>typeof v==='string'&&v.length&&v.length<=4096&&!v.includes('\0'))&&!seen.has(tool.key)&&seen.add(tool.key));
}
export function toolChoices(tools,preferences={},query=''){
  const p=validateLaunchPreferences(preferences),installed=installedTools(tools),hidden=new Set(p.hidden),eligible=installed.filter(t=>!hidden.has(t.key));
  const defaultOrder=['claude','codex','grok'];
  const pins=p.pins??[...defaultOrder.filter(k=>eligible.some(t=>t.key===k)),...eligible.filter(t=>!defaultOrder.includes(t.key)).map(t=>t.key)].slice(0,3);
  const quick=pins.map(k=>eligible.find(t=>t.key===k)).filter(Boolean).slice(0,3),filter=query.trim().toLowerCase();
  return {quick,all:eligible.filter(t=>!filter||`${t.key} ${t.name}`.toLowerCase().includes(filter)),overflow:eligible.filter(t=>!quick.includes(t)),hidden:installed.filter(t=>hidden.has(t.key))};
}
export async function saveLaunchPreferences(io,next){const p=validateLaunchPreferences(next);return updateConfig(io,config=>{config.preferences.launch=p;});}
