import {localTerminalAddress,machineIdentity} from '../../shared/session-identity.js';

const rank={blocked:0,done:1,working:2,idle:3},headings={blocked:'Needs you',done:'Done',working:'Working',idle:'Idle'};
const normalized=(status,{child=false,listed=false}={})=>status==='error'?'blocked':child&&!listed&&status==='done'?'idle':Object.hasOwn(rank,status)?status:'idle';
const clean=value=>typeof value==='string'?value.replace(/[\u0000-\u001f]/g,' ').trim().slice(0,200):'';
const tabKey=(machine,tab)=>JSON.stringify([machine,tab]);
const meaningful=(value,program)=>{const name=clean(value);return name&&!/^\d+$/.test(name)&&!/^[/~]|^[A-Za-z]:[\\/]/.test(name)&&![program?.name,program?.key,'Terminal','Agent'].some(v=>v&&name.toLowerCase()===v.toLowerCase())&&!/^(claude(?: code)?|codex|grok)(?:\s+v?[\d.]+)?$/i.test(name)?name:null;};
export function agentTitle(agent,{tab,ownership,taskTitle}={}){
  if(ownership?.mode==='manual'&&clean(ownership.manualName))return clean(ownership.manualName);
  return meaningful(taskTitle,agent.program)||meaningful(tab?.named?tab.name:null,agent.program)||meaningful(agent.title,agent.program)||meaningful(ownership?.lastAutoName,agent.program)||meaningful(agent.tab_name,agent.program)||'Agent';
}
function metrics(reading){
  const c=reading?.context,q=reading?.quota,windows=Array.isArray(q?.windows)?q.windows:[],percent=windows.length?Math.min(...windows.map(w=>w.remainingPercent)):null;
  const quotaScope=q?.scope==='shared-account'?`Shared account · ${q.identity.credentialScope} · ${q.identity.accountId?.slice(0,8)}`:q?.scope==='session-observation'?'Session observation; account allowance is not independently proven.':'Account quota unavailable.';
  return {context:{state:c?.state||'unavailable',percent:c?.remainingPercent??null,estimated:c?.basis==='estimate',scope:c?.reason||'No exact session context observation.',reason:c?.reason||'No exact session context observation.'},quota:{state:q?.state||'unavailable',percent,scope:[quotaScope,q?.reason,...windows.map(w=>`${w.name}: ${Math.round(w.remainingPercent)}%${w.resetsAt?' · resets '+new Date(w.resetsAt).toISOString():''}`)].filter(Boolean).join('\n'),reason:q?.reason||'No exact account quota observation.'}};
}

/** Pure display model. Titles never establish session identity or merge rows. */
export function buildAgentModel({agents=[],terminals=[],spaces=[],mode='priority',query='',folded=new Set(),readings=new Map(),names=null,taskTitles=new Map()}={}){
  const native=new Map(),raw=new Map(terminals.map(t=>[t.address,t])),rowsByAddress=new Map(),needle=clean(query).toLowerCase();
  for(const[order,agent]of agents.entries()){
    const space=spaces.find(s=>s.id===agent.space),machine=space?machineIdentity(space.machine):null;let address=agent.address,focus=null;
    try{if(space){const local=localTerminalAddress(address,machine);address=machine?machine+'/'+local:local;focus={command:'agent.focus',args:{terminal:address}};}}catch{}
    const tab=space?.tabs?.find(t=>t.id===agent.tab),origin=names?.tabs?.[tabKey(machine,agent.tab)],ownership=origin?names.origins?.[origin]:null;
    native.set(address,{...agent,address,machine,spaceInfo:space,order,title:agentTitle(agent,{tab,ownership,taskTitle:taskTitles.get(tabKey(machine,agent.tab))}),status:normalized(agent.status),focus,native:true});
  }
  const children=new Map();for(const terminal of terminals)if(terminal.parent&&terminal.state==='live'){if(!children.has(terminal.parent))children.set(terminal.parent,[]);children.get(terminal.parent).push(terminal);}
  const seen=new Set(),forests=[];
  function forest(root){
    const members=[],stack=[{node:root,depth:0,parent:null}];
    while(stack.length){
      const{node,depth,parent}=stack.pop();if(seen.has(node.address))continue;seen.add(node.address);
      const listed=native.get(node.address),base=listed||{...node,machine:root.machine,space:root.space,spaceInfo:root.spaceInfo,title:agentTitle({...node,title:node.name||node.title,tab_name:null}),status:normalized(node.status,{child:true}),focus:{command:'terminal.peek',args:{terminal:node.address}},native:false};
      const row={...base,depth,parent,root:root.address,spaceName:base.spaceInfo?.name||base.space_name||'Unavailable space',...metrics(readings.get(node.address))};
      row.matches=!needle||`${row.title} ${row.spaceName} ${row.machine||'This Mac'} ${row.status}`.toLowerCase().includes(needle);members.push(row);rowsByAddress.set(row.address,row);
      const kids=(children.get(node.address)||[]).filter(t=>{if(root.machine?!t.address.startsWith(root.machine+'/'):t.address.includes('/'))return false;try{localTerminalAddress(t.address,root.machine);return true;}catch{return false;}});for(let i=kids.length-1;i>=0;i--)stack.push({node:kids[i],depth:depth+1,parent:node.address});
    }
    const effective=members.reduce((status,row)=>rank[row.status]<rank[status]?row.status:status,root.status);
    const include=new Set();for(const row of members)if(row.matches){let current=row;while(current){include.add(current.address);current=rowsByAddress.get(current.parent);}if(row.address===root.address)for(const child of members)include.add(child.address);}
    const visible=members.filter(row=>include.has(row.address)&&(needle||!folded.has(root.address)||row.depth===0));
    if(visible.length)forests.push({root,effective,rows:visible,descendantCount:members.length-1});
  }
  const ancestorListed=address=>{const visited=new Set([address]);let parent=raw.get(address)?.parent;while(parent&&!visited.has(parent)){if(native.has(parent))return true;visited.add(parent);parent=raw.get(parent)?.parent;}return false;};
  for(const root of native.values())if(!ancestorListed(root.address)&&!seen.has(root.address))forest(root);
  for(const root of native.values())if(!seen.has(root.address))forest(root); // malformed parent cycles remain bounded and visible.
  const groups=[];
  if(mode==='spaces'){
    const order=new Map(spaces.map((s,i)=>[s.id,i])),sorted=[...forests].sort((a,b)=>(order.get(a.root.space)??Infinity)-(order.get(b.root.space)??Infinity)||a.root.order-b.root.order),map=new Map();
    for(const tree of sorted){const key=tabKey(tree.root.machine,tree.root.space);if(!map.has(key)){const group={key,label:tree.root.spaceInfo?.name||'Unavailable space',machine:tree.root.machine,rows:[]};map.set(key,group);groups.push(group);}map.get(key).rows.push(...tree.rows);}
  }else for(const status of ['blocked','done','working','idle']){const trees=forests.filter(t=>t.effective===status).sort((a,b)=>a.root.order-b.root.order);if(trees.length)groups.push({key:status,label:headings[status],status,rows:trees.flatMap(t=>t.rows)});}
  const rows=groups.flatMap(group=>group.rows),navigation=rows.filter(row=>row.native).map(row=>row.address);
  // Herdr appends omitted agents to its order. Preserve those hidden by a
  // deliberate search/fold in their original native order, exactly once.
  for(const address of native.keys())if(!navigation.includes(address))navigation.push(address);
  return {groups,rows,navigation,count:native.size,visibleCount:rows.length};
}
