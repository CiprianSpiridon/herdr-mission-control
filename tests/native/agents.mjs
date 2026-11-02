import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {run,until} from '../../scripts/native-harness.mjs';
import {BindingStore,argvSessionProof} from '../../src/shared/session-bindings.js';
import {terminalIdentity} from '../../src/shared/session-identity.js';

const MOD='mission-control-agents',sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const shell=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const ACTOR=String.raw`#!/usr/bin/env python3
import sys,os,time,json,datetime
if '--version' in sys.argv: print('Native QA fixture 1.0');sys.exit(0)
if '--help' in sys.argv:
 print('Codex CLI QA fixture\nUsage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]' if 'codex' in sys.argv[0] else 'Claude Code QA fixture\n --session-id <uuid>\n --resume [value]');sys.exit(0)
spec=json.load(open(sys.argv[-1]))
os.makedirs(os.path.dirname(spec['log']),exist_ok=True)
if not spec.get('noLog'):
 with open(spec['log'],'w') as f:
  if spec['provider']=='codex': f.write(json.dumps({'type':'session_meta','payload':{'id':spec['id'],'session_id':spec['id'],'cwd':spec['repo'],'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cli_version':'native-qa'}})+'\n')
print('\x1b]2;'+spec['title']+'\x1b\\',end='',flush=True)
print('WorkerReady' if spec.get('worker') else 'Disposable native fixture agent; no provider request is made.',flush=True)
while True:
 if os.path.exists(spec.get('lossFile','')): os.kill(os.getpid(),9)
 stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if not spec.get('noLog'):
  if spec['provider']=='codex': row={'type':'event_msg','timestamp':stamp,'payload':{'type':'token_count','thread_id':spec['id'],'info':{'last_token_usage':{'total_tokens':spec['used']},'model_context_window':100},'rate_limits':{'primary':{'used_percent':25,'window_minutes':300}}}}
  else: row={'type':'assistant','sessionId':spec['id'],'cwd':spec['repo'],'timestamp':stamp,'message':{'usage':{'input_tokens':spec['used'],'cache_read_input_tokens':0,'cache_creation_input_tokens':0,'output_tokens':1}}}
  with open(spec['log'],'a') as f: f.write(json.dumps(row)+'\n')
 if spec.get('quotaFile'):
  raw=spec['quota'];raw['fetched_at_unix']=int(time.time())
  for sid,observations in raw['session_quota_observations'].items():
   for o in observations:o['observed_at_unix']=int(time.time())-(10 if sid==spec['olderQuotaSession'] else 0)
  tmp=spec['quotaFile']+'.next';json.dump(raw,open(tmp,'w'));os.replace(tmp,spec['quotaFile'])
 state=spec['status']
 if os.path.exists(spec.get('statusFile','')):
  requested=open(spec['statusFile']).read().strip()
  if requested in ['working','blocked','done','idle']: state=requested
 print('\x1b]7501;state='+state+':app='+('codex' if spec['provider']=='codex' else 'claude-code')+'\x1b\\',end='',flush=True)
 time.sleep(3)
`;

export default async function agents(runtime){
  const home=runtime.env.HERDR_APP_HOME,actors=[],roots={codex:path.join(runtime.directory,'providers/.codex'),claude:path.join(runtime.directory,'providers/.claude')};
  const progress=stage=>fs.writeFile(path.resolve('.harness/agents-progress.json'),JSON.stringify({stage,nonce:runtime.nonce,assertions:runtime.assertions.length})+'\n');
  await progress('preparing native agent fixtures');
  const io={appHome:()=>home,ensureDirectory:dir=>fs.mkdir(dir,{recursive:true}),readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}},writeTextFile:async(file,text,expected)=>{let raw=null;try{raw=sync.readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}if(raw!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,text);}};
  const bindings=new BindingStore(io);
  for(const provider of ['codex','claude'])await fs.mkdir(roots[provider]+(provider==='codex'?'/sessions':'/projects'),{recursive:true});
  await fs.mkdir(roots.claude+'/cache',{recursive:true});
  const tools={codex:path.join(runtime.directory,'qa-codex'),claude:path.join(runtime.directory,'qa-claude')};
  for(const tool of Object.values(tools)){await fs.writeFile(tool,ACTOR);await fs.chmod(tool,0o700);}
  await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:{codex:{run:[tools.codex]},claude:{run:[tools.claude]}}}));
  await fs.mkdir(home+'/mission-control',{recursive:true});
  const sources={codex:{v:1,enabled:true,machine:null,provider:'codex',credentialScope:'qa-codex',providerRoot:roots.codex,roots:[roots.codex+'/sessions']},claude:{v:1,enabled:true,machine:null,provider:'claude',credentialScope:'qa-claude',providerRoot:roots.claude,roots:[roots.claude+'/projects'],cacheRoots:[roots.claude+'/cache']}};
  await fs.writeFile(home+'/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:sources}));
  const repos=[runtime.repo,await runtime.createRepo('api-repo'),await runtime.createRepo('infra-repo'),await runtime.createRepo('mobile-repo')];
  const labels=['Fix login redirect','Review token refresh','Improve account settings','Fix search filtering','Update request tracing','Review deployment checks','Repair pagination','Improve session recovery'];
  for(let index=0;index<32;index++){
    const provider=index<2||index===31||index>=4&&index%2===0?'codex':'claude',id=crypto.randomUUID(),group=Math.floor(index/8),space=group===0?runtime.spaceId:runtime.spaceId+'-'+group,tab='qa-agent-'+String(index).padStart(2,'0'),title='Task '+String(index).padStart(2,'0')+' '+labels[index%labels.length];
    const spec={provider,id,repo:repos[group],title,status:['working','blocked','done','idle'][index%4],used:index===0?17:index===1?63:30+index%20,log:roots[provider]+(provider==='codex'?'/sessions/rollout-':'/projects/')+id+'.jsonl',noLog:index===30,lossFile:path.join(runtime.directory,'lose-agent-'+index),statusFile:path.join(runtime.directory,'status-agent-'+index)};
    const file=path.join(runtime.directory,'actor-'+index+'.json');await fs.writeFile(file,JSON.stringify(spec));const argv=[tools[provider],provider==='codex'?'resume':'--session-id',id,file];
    const ack=runtime.hc(['run','--bg','--no-parent','--cwd',spec.repo,'--name','qa-agent-'+index,'--label','herdr.space='+space,'--label','herdr.tab='+tab,'--',...argv]);
    actors.push({index,provider,id,space,tab,title,spec,file,argv,address:ack.address,requestId:'qa-request-'+index});
  }
  const quota={provider:'claude',source:'claude-statusline',session_quota_only:true,fetched_at_unix:Math.floor(Date.now()/1000),session_contexts:{},session_windows:{},session_quota_observations:{},session_accounts:{}};
  for(const actor of actors.filter(a=>a.provider==='claude')){
    const shared=actor.index===2||actor.index===3,remaining=actor.index===2?65:actor.index===3?20:84;
    quota.session_contexts[actor.id]={used_percent:actor.spec.used};quota.session_windows[actor.id]=[{kind:'five_hour',used_percent:100-remaining,remaining_percent:remaining,resets_at:Math.floor(Date.now()/1000)+3600}];quota.session_quota_observations[actor.id]=[{kind:'five_hour',observed_at_unix:Math.floor(Date.now()/1000)-(actor.index===2?10:0)}];quota.session_accounts[actor.id]=(shared?'a':'b').repeat(64);
  }
  const quotaFile=roots.claude+'/cache/claude-statusline.json';await fs.writeFile(quotaFile,JSON.stringify(quota));
  // Exactly one fixture owns this sanitized cache; no concurrent writers.
  const writer=actors[2];Object.assign(writer.spec,{quotaFile,quota,olderQuotaSession:actors[2].id});await fs.writeFile(writer.file,JSON.stringify(writer.spec));
  // Its process loaded the old file already: restart this one owned fixture
  // before binding so its launch generation and quota writer are both real.
  runtime.hc(['kill',writer.address,'--json']);await until(()=>runtime.hc(['get',writer.address,'--json']).state==='finished','old fixture writer stopped');runtime.hc(['rm',writer.address,'--json']);const replacement=runtime.hc(['run','--bg','--no-parent','--cwd',writer.spec.repo,'--name','qa-quota-writer','--label','herdr.space='+writer.space,'--label','herdr.tab='+writer.tab,'--',...writer.argv]);writer.address=replacement.address;
  for(const actor of actors){
    const raw=await until(()=>{const value=runtime.hc(['get',actor.address,'--json']);return value.foreground?.pid&&value.status?.state?value:null;},'fixture foreground and actual OSC status');
    runtime.expect(JSON.stringify(raw.argv)===JSON.stringify(actor.argv),'Owned fixture command and exact session argv verified '+actor.index);
    runtime.expect(raw.status.state===actor.spec.status,'Actual OSC status matches fixture state '+actor.spec.status);
    if(actor.index===31)continue;
    const session={machine:null,provider:actor.provider,credentialScope:sources[actor.provider].credentialScope,providerRoot:roots[actor.provider],sessionId:actor.id},terminal=terminalIdentity(raw,null);
    await bindings.propose({requestId:actor.requestId,originId:'qa-origin-'+actor.index,session});await bindings.commitAcknowledged(actor.requestId,{tabId:actor.tab,terminal},argvSessionProof({capabilities:{machine:null,provider:actor.provider,run:[tools[actor.provider]],...(actor.provider==='codex'?{resume:{kind:'command',command:'resume'}}:{callerSession:'--session-id'})},session,terminal,argv:actor.argv,kind:actor.provider==='codex'?'resume-argv':'caller-session-id',observedAt:Date.now(),sourceDigest:sha(JSON.stringify(raw.argv))}));
  }
  const workerSpec={provider:'claude',id:crypto.randomUUID(),title:'Inspect worker trace',status:'blocked',used:10,repo:runtime.repo,log:roots.claude+'/projects/worker.jsonl',worker:true},workerFile=path.join(runtime.directory,'worker.json');await fs.writeFile(workerFile,JSON.stringify(workerSpec));
  const worker=runtime.hc(['run','--bg','--parent',actors[0].address,'--no-notify','--cwd',runtime.repo,'--',tools.claude,'--session-id',workerSpec.id,workerFile]);
  const gate=path.join(runtime.directory,'hold-collector'),entered=path.join(runtime.directory,'collector-entered.json'),shim=path.join(runtime.directory,'shim');await fs.mkdir(shim);
  const python=run('which',['python3'],{env:runtime.env,json:false});
  await fs.writeFile(shim+'/python3',`#!/bin/sh
if [ "$1" = "-c" ] && [ -f ${shell(gate)} ]; then
  printf '%s' "$3" > ${shell(entered)}
  n=0
  while [ -f ${shell(gate)} ] && [ "$n" -lt 300 ]; do sleep 0.05; n=$((n+1)); done
fi
exec ${shell(python)} "$@"
`);await fs.chmod(shim+'/python3',0o700);runtime.env.PATH=shim+':'+runtime.env.PATH;
  const manifest=await runtime.installPackage(MOD),compatibility=JSON.parse(await fs.readFile('evidence/native/provider-compatibility.json','utf8'));
  runtime.expect(compatibility.status==='PASS'&&manifest.artifacts['collector.py']===compatibility.collectorSourceSha256,'Exact bundled collector passed separate actual installed-provider compatibility');
  for(const[name,hash]of Object.entries(compatibility.helperSourceSha256))runtime.expect(manifest.sources['src/shared/'+name]===hash,'Verified provider helper matches native package '+name);
  await fs.writeFile(home+'/window.json',JSON.stringify({state:'windowed',bounds:[100,100,1100,850]}));
  const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
  await runtime.startWindow({name:'agents-native',layout:{id:'qa-root',type:'row',titlebar:'none',traffic_lights:[12,16],background:'canvas',children:[
    {id:'sidebar',type:'column',size:{px:220},background:'chrome',children:[block('brand','workspace-chrome',46),block('spaces','spaces',180),block('agents',MOD),block('footer','workspace-chrome',69,{footer:true})]},
    {id:'work',type:'column',children:[block('tabs','tabs',42),{id:'main',type:'block',content:{tab:'active'}},block('status','workspace-status',28)]}
  ]}});
  await until(()=>{const spaces=runtime.app(['ls']).spaces||[];return actors.every(actor=>spaces.some(space=>space.id===actor.space));},'all four fixture spaces imported into the native window');
  for(const[index,name]of ['client-portal','api-service','infrastructure','mobile-app'].entries())runtime.app(['do','space.rename',JSON.stringify({id:index===0?runtime.spaceId:runtime.spaceId+'-'+index,name})]);
  const top=226,renderFailures=[];let serial=0;
  const observe=async(query='')=>{const frame=await runtime.frame('agents-observe-'+(++serial)),observation=await runtime.driver.ocr(path.resolve(frame.path),query);for(const line of observation.lines)if(line.text.toLowerCase().replaceAll('-',' ').includes('could not be re rendered'))renderFailures.push(line.text);return observation;};
  const inSidebar=node=>node.frame.x<220&&node.frame.y>top;
  const inDialog=(node,observation)=>node.frame.x>=(observation.window.width-720)/2&&node.frame.x+node.frame.width<=(observation.window.width+720)/2&&node.frame.y>=(observation.window.height-660)/2&&node.frame.y+node.frame.height<=(observation.window.height+660)/2;
  const has=async(query,where=()=>true)=>{const observation=await observe(query);return observation.matches.some(node=>node.confidence>=0.5&&where(node,observation));};
  const click=async(query,where=()=>true)=>{const selected=await until(async()=>{const observation=await observe(query),matches=observation.matches.filter(n=>n.confidence>=0.6&&where(n,observation));return matches.length===1?{observation,node:matches[0]}:null;},'unique native control '+query);await runtime.driver.clickObservedText(selected.observation,selected.node);};
  const header=async(name)=>{const observation=await observe();runtime.expect(observation.lines.some(n=>n.text.includes('Agents')),'Observed native Agents header before '+name);const positions={collapse:8,priority:132,spaces:160,sources:188};await runtime.driver.click({x:positions[name],y:top+4,width:name==='collapse'?28:24,height:24},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Agents '+name,observation:observation.source});};
  const search=async value=>{const observation=await observe();await runtime.driver.click({x:42,y:top+32+4,width:142,height:22},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Find an agent',observation:observation.source});await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');for(const character of value)await runtime.driver.press(character===' '?'space':character);await until(async()=>(await runtime.shared())['mission-control-agents-v1']?.query===value,'native agent search '+value);};
  const close=async()=>{await runtime.driver.press('escape');await until(()=>runtime.app(['status']).overlays.length===0,'closed native source dialog');};
  try{
    await progress('native agents mounted');await until(()=>has('32',inSidebar),'native Agents count for 32 fixtures');runtime.expect(await has('32',inSidebar),'The mounted native Agents heading contains 32 fixture agents');
    await search('00');await until(()=>has('83%',inSidebar),'exact first context from real fixture JSONL',40000);runtime.expect(await has('Inspect worker',inSidebar),'Actual sub-agent row is reachable beneath its parent');
    runtime.expect(await has('Unavailable',inSidebar),'Unbound sub-agent has its own unavailable metrics');
    await click('Task 00',inSidebar);await until(()=>runtime.app(['status']).tab===actors[0].tab,'native parent agent focus');runtime.expect(runtime.app(['status']).tab===actors[0].tab,'Native row focuses its exact parent agent');
    await click('Inspect worker',inSidebar);await until(()=>has('WorkerReady'),'actual child peek content');runtime.expect(await has('WorkerReady'),'Sub-agent click peeks the actual child terminal');
    // Escape goes to the focused terminal in Herdr's shipped peek. Use the
    // visible close control in its actual 1100x850 fixture window instead.
    const peekObservation=await observe('WorkerReady');await runtime.driver.click({x:950,y:90,width:28,height:28},{expectedSize:peekObservation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Close child peek',observation:peekObservation.source});await until(()=>runtime.app(['status']).overlays.length===0,'native child peek closed');
    await search('01');await until(()=>has('37%',inSidebar),'separate second session context');runtime.expect(await has('37%',inSidebar),'Same-repo Codex sessions retain distinct context readings');
    // The startup-selected terminal can have its first completion marked
    // seen. Produce a fresh real completion while another pane is focused.
    await fs.writeFile(actors[2].spec.statusFile,'working');await until(()=>runtime.hc(['get',actors[2].address,'--json']).status.state==='working','fixture begins a fresh turn');await fs.writeFile(actors[2].spec.statusFile,'done');await until(()=>runtime.hc(['get',actors[2].address,'--json']).status.state==='done','fixture finishes unseen turn');
    for(const index of ['02','03']){await search(index);await until(()=>has('20%',inSidebar),'shared exact Claude quota '+index);runtime.expect(await has('20%',inSidebar),'Proven same-account Claude sessions share the newest quota '+index);runtime.expect(await has('Unavailable',inSidebar),'Claude context stays unavailable without a reported window/date '+index);const group=index==='02'?'Done':'Idle';runtime.expect(Boolean(await until(()=>has(group,inSidebar),'native '+group+' group header',20000).catch(()=>false)),'Native '+group+' status group renders');}
    await search('30');runtime.expect(await has('Unavailable',inSidebar),'Missing observation stays unavailable rather than borrowing another session');
    await search('31');runtime.expect(await has('Unavailable',inSidebar),'Fresh unbound Codex stays unavailable despite same-repo observation files');
    await search('');await header('spaces');await until(async()=>(await runtime.shared())['mission-control-agents-v1']?.mode==='spaces','native space grouping');
    const groupHeading=await until(async()=>{const observation=await observe(),lines=observation.lines.filter(inSidebar),firstTask=Math.min(...lines.filter(n=>/Task\s+[0-9O]{2}/i.test(n.text)).map(n=>n.frame.y));if(!Number.isFinite(firstTask))return null;return lines.find(n=>n.frame.y<firstTask&&['client-portal','api-service','infrastructure','mobile-app'].some(name=>n.text.includes(name)));},'visible first repository group heading');runtime.expect(Boolean(groupHeading),'Space grouping has a distinct native repository heading');
    await header('priority');await until(async()=>(await runtime.shared())['mission-control-agents-v1']?.mode==='priority','native priority grouping');await click('Task 00',inSidebar);await until(()=>runtime.app(['status']).tab===actors[0].tab,'parent focused before keyboard navigation');
    // Native model order is authoritative within a priority group; it need
    // not be fixture creation order. Read the actual following displayed row.
    const nextActor=await until(async()=>{const observation=await observe(),visible=observation.lines.filter(inSidebar).map(node=>{const match=node.text.match(/(?:^|\s)Task\s+([0-9O]{2})(?:\s|$)/i);return match?{index:Number(match[1].toUpperCase().replaceAll('O','0')),y:node.frame.y}:null;}).filter(Boolean).sort((a,b)=>a.y-b.y),current=visible.findIndex(row=>row.index===0);return current>=0&&visible[current+1]?actors[visible[current+1].index]:null;},'next native row visibly follows the focused agent');
    runtime.app(['do','agent.next']);await until(()=>runtime.app(['status']).tab===nextActor.tab,'native next-agent follows displayed priority');runtime.expect(runtime.app(['status']).tab===nextActor.tab,'Native agent.next follows the order set by the mounted grouping');
    await header('collapse');await until(async()=>(await runtime.shared())['mission-control-agents-v1']?.collapsed===true,'native Agents collapsed');runtime.expect(await has('Spaces',n=>n.frame.x<220&&n.frame.y<top),'Collapsing Agents preserves Spaces');await header('collapse');
    await header('spaces');await search('');runtime.app(['do','agent.focus',JSON.stringify({terminal:actors[0].address})]);
    const preview=await runtime.frame('agents-preview');await fs.copyFile(path.resolve(preview.path),path.resolve(MOD,'preview.png'));await progress('native focus, grouping and metric states passed');
    // Keep the collector in an actual owned exec while its source is disabled
    // through native controls. The shim delegates unchanged bytes to Python.
    await fs.rm(entered,{force:true});await fs.writeFile(gate,'hold');await until(async()=>{try{return JSON.parse(await fs.readFile(entered,'utf8')).source?.provider==='codex';}catch{return false;}},'owned Codex collector in flight',90000);
    await header('sources');const nameObservation=await observe('Codex'),titles=nameObservation.matches.filter(n=>inDialog(n,nameObservation)).sort((a,b)=>a.frame.y-b.frame.y);runtime.expect(titles.length>0,'Observed actual source paths/dialog');const y=titles[0].frame.y+titles[0].frame.height/2;
    await click('Enabled',(n,o)=>inDialog(n,o)&&Math.abs(n.frame.y+n.frame.height/2-y)<20);
    await until(async()=>JSON.parse(await fs.readFile(home+'/mission-control/config.json','utf8')).usageSources.codex.enabled===false,'native source disable saved');await fs.rm(gate,{force:true});
    runtime.expect((await bindings.requestState(actors[0].requestId)).state==='invalidated','Native source disable invalidates its durable mappings');await close();await search('00');await until(()=>has('Unavailable',inSidebar),'disabled-source unavailable state');runtime.expect(!(await has('83%',inSidebar)),'Late collector result cannot republish the disabled source');
    await search('03');runtime.expect(await has('20%',inSidebar),'Disabling Codex preserves the separately scoped Claude account reading');
    // A kept terminal becoming a shell is no longer listed as an agent; the
    // binding sweep still has to invalidate its previous foreground identity.
    const replaced=actors[5],beforeLoss=runtime.hc(['get',replaced.address,'--json']);runtime.hc(['keep',replaced.address,'--json']);await fs.writeFile(replaced.spec.lossFile,'lose');await until(()=>{const raw=runtime.hc(['get',replaced.address,'--json']);return raw.state==='live'&&raw.foreground?.pid&&raw.foreground.pid!==beforeLoss.foreground.pid;},'actual kept-terminal recovery to a fresh shell',20000);await until(async()=>(await bindings.requestState(replaced.requestId)).state==='invalidated','replaced shell generation invalidated',45000);runtime.expect((await bindings.requestState(replaced.requestId)).state==='invalidated','A kept agent replaced by a shell loses its exact-session binding');
    for(const actor of [...actors,{address:worker.address}]){const raw=runtime.hc(['get',actor.address,'--json']);if(raw.state==='live')runtime.hc(['kill',actor.address,'--json']);}
    await search('');await until(()=>has('No agents running.',inSidebar),'native empty Agents state');runtime.expect(await has('No agents running.',inSidebar),'Empty list remains usable after fixture agents end');
    runtime.expect(runtime.app(['status']).errors.length===0,'No native errors after Agents interactions');runtime.expect(renderFailures.length===0,'No interrupted-render banner appeared in any observed native frame');runtime.expect((await fs.readdir(home+'/mods')).filter(n=>n.startsWith('mission-control-')).join(',')===MOD,'Only this standalone custom mod was installed');await progress('native Agents scenario passed');
  }catch(error){try{await fs.rm(gate,{force:true});await runtime.frame('agents-failure');const directory=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.writeFile(path.join(directory,'native-console.txt'),runtime.appStdout+'\n'+runtime.appStderr);await fs.writeFile(path.join(directory,'failure-status.json'),JSON.stringify(runtime.app(['status']),null,2));await fs.writeFile(path.join(directory,'failure-shared.json'),JSON.stringify(await runtime.shared(),null,2));await fs.writeFile(path.join(directory,'fixture-bindings.json'),JSON.stringify((await bindings.read()).value,null,2));await fs.copyFile(home+'/mission-control/config.json',path.join(directory,'fixture-config.json'));await fs.writeFile(path.join(directory,'fixture-generation.json'),JSON.stringify(runtime.hc(['get',actors[0].address,'--json']),null,2));await fs.copyFile(actors[0].spec.log,path.join(directory,'fixture-codex-log.jsonl'));}catch{}throw error;}
}
