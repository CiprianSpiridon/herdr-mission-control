export {resolveSpaceRepo,launchTarget} from '../../shared/space-repo.js';
import {machineIdentity} from '../../shared/session-identity.js';
export const machineGroupKey=machine=>JSON.stringify([machineIdentity(machine)]);
export function groupSpaces(spaces,{query='',collapsed={}}={}){
  const groups=new Map(),needle=query.trim().toLowerCase();
  for(const space of spaces){
    const machine=machineIdentity(space.machine),key=machineGroupKey(machine),label=machine||'This Mac';
    if(needle&&!`${space.name||''} ${space.branch||''} ${space.repoRoot||''} ${label}`.toLowerCase().includes(needle))continue;
    if(!groups.has(key))groups.set(key,{machine,key,label,collapsed:Boolean(collapsed[key]),spaces:[]});groups.get(key).spaces.push(space);
  }
  return [...groups.values()].sort((a,b)=>a.machine===null?-1:b.machine===null?1:a.label<b.label?-1:a.label>b.label?1:0);
}
export function capturedSpace(spaces,id,machine){return spaces.find(s=>s.id===id&&machineIdentity(s.machine)===machineIdentity(machine))||null;}
