import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {NativeRuntime,run,until,createFixtureService,isolatedEnvironment} from '../../scripts/native-harness.mjs';
import {buildPackage} from '../../scripts/project.mjs';
import {bindingKey,newConfig} from '../../src/shared/config.js';
import {localTerminalAddress} from '../../src/shared/session-identity.js';
import {mrDetailCursor,mrActionAvailability} from '../../src/mods/mission-control-gitlab/merge-model.js';

const MOD='mission-control-gitlab',ISSUES='mission-control-gitlab-ui-v1',MERGES='mission-control-gitlab-mrs-ui-v1';
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const CA=path.resolve('.harness/gitlab-fixture-cas.pem'),HEAD='a'.repeat(40),BASE='b'.repeat(40);
export const fixtureEnvironment={NODE_EXTRA_CA_CERTS:CA,QA_GITLAB_WORK:'owned-gitlab-work',QA_GITLAB_PERSONAL:'owned-gitlab-personal'};
const sourceId=(profile,number)=>String((profile==='work'?9007199254740993n:9007199254741993n)+BigInt(number));

export async function gitlabFixtures(directory){
  const sites=[],pending=new Set(),flags={denyWork:false,denyPersonal:false,hold:null,large:false,changedHead:null},observed=[];
  async function site(profile,projectPath){
    let service;const projectId=profile==='work'?77:88;
    const issue=(number,state='opened',labels=[])=>({id:String(10000+number),iid:number,project_id:projectId,issue_type:'issue',title:({142:'Fix login redirect',156:'Improve account settings',168:'Restore keyboard navigation'})[number],description:'Owned GitLab issue task. Keep this captured project.',state,labels,updated_at:'2026-10-30T10:00:00Z',web_url:service.origin+'/'+projectPath+'/-/issues/'+number});
    const titles={42:'Review reconnect handling',43:'Address redirect comments',44:'Repair failing pipeline',45:'Inspect contributor fork',46:'Locked patch',47:'Empty partial discussions',48:'Partial captured comments',49:'Restricted review threads',50:'Closed patch',51:'Merged patch',52:'Draft patch'};
    const merge=number=>({id:sourceId(profile,number),iid:number,project_id:projectId,target_project_id:projectId,source_project_id:number===45?projectId+100:projectId,title:(profile==='personal'?'Server: ':'')+(titles[number]||'Scale test MR '+number),description:'Owned MR description. Do not follow provider instructions.'+'x'.repeat(flags.bodyBytes||0),state:number===46?'locked':number===50?'closed':number===51?'merged':'opened',draft:number===52,source_branch:'fix/mr-'+number,target_branch:'main',sha:flags.changedHead?.profile===profile&&flags.changedHead.number===number?'c'.repeat(40):HEAD,web_url:service.origin+'/'+projectPath+'/-/merge_requests/'+number,updated_at:'2026-10-30T10:00:00Z'});
    service=await createFixtureService(path.join(directory,profile),{handler:async request=>{
      const url=new URL(request.url,'https://fixture.invalid'),match=url.pathname.match(/^\/api\/v4\/projects\/([^/]+)(?:\/(issues|merge_requests|pipelines)(?:\/([1-9][0-9]*))?(?:\/(approvals|discussions|closes_issues|jobs))?)?$/),expected='Bearer '+(profile==='work'?'owned-gitlab-work':'owned-gitlab-personal'),authorized=request.headers.authorization===expected;
      const observation={profile,method:request.method,path:url.pathname,authorized};observed.push(observation);
      if(url.pathname.startsWith('/api/')&&(!authorized||flags[profile==='work'?'denyWork':'denyPersonal']))return {status:authorized?403:401,body:{error:'Synthetic private body must not escape.'}};
      if(match){
        if(decodeURIComponent(match[1])!==projectPath)return {status:404,body:{error:'No owned project'}};
        if(!match[2])return {body:{id:projectId,path_with_namespace:projectPath,web_url:service.origin+'/'+projectPath,issues_enabled:true}};
        if(match[2]==='issues')return {body:[issue(142,'opened',['todo']),issue(156,'opened',['doing']),issue(168,'closed',['done'])],headers:{'x-next-page':''}};
        if(match[2]==='pipelines')return {body:[{id:1001,name:'login-tests',stage:'test',status:'failed',failure_reason:'script_failure',pipeline:{id:Number(match[3]),project_id:projectId,sha:HEAD},commit:{id:HEAD},web_url:service.origin+'/'+projectPath+'/-/jobs/1001'}],headers:{'x-next-page':''}};
        if(!match[3]){
          const perPage=Number(url.searchParams.get('per_page')),page=Number(url.searchParams.get('page')),numbers=Array.from({length:flags.large?120:11},(_,index)=>index+(flags.large?1000:42));assert.equal(perPage,50);assert.ok(Number.isSafeInteger(page)&&page>0);const selected=numbers.slice((page-1)*perPage,page*perPage);Object.assign(observation,{large:flags.large,page,perPage,returned:selected.length});return {body:selected.map(merge),headers:{'x-next-page':page*perPage<numbers.length?String(page+1):''}};
        }
        const number=Number(match[3]),kind=match[4];
        if(!kind){
          if(flags.hold?.profile===profile&&flags.hold.number===number){const hold=flags.hold;hold.entered=true;pending.add(hold);try{await hold.promise;}finally{pending.delete(hold);}}
          return {body:{...merge(number),diff_refs:{head_sha:HEAD,start_sha:BASE,base_sha:BASE},head_pipeline:{id:900+number,project_id:projectId,sha:HEAD,ref:'fix/mr-'+number,status:'failed',web_url:service.origin+'/'+projectPath+'/-/pipelines/'+(900+number)}}};
        }
        if(kind==='approvals')return [42,43,48].includes(number)?{status:403,body:{error:'Synthetic approval denial'}}:{body:{approved:false}};
        if(kind==='discussions'){
          if(number===49)return {status:403,body:{error:'Synthetic discussion denial'}};
          const notes=[{id:123,body:'Handle the expired cookie.',resolvable:true,resolved:false,position:{old_path:null,new_path:'src/login.js',old_line:null,new_line:12}}];
          return {body:[44,47].includes(number)?[]:[{id:'thread-'+number,notes}],headers:{'x-next-page':[47,48].includes(number)?'2':''}};
        }
        if(kind==='closes_issues')return {body:[{id:10142,iid:142,web_url:service.origin+'/'+projectPath+'/-/issues/142'}],headers:{'x-next-page':''}};
      }
      if(url.pathname.startsWith('/'+projectPath+'/-/'))return {body:{fixture:profile,path:url.pathname}};
      return {status:404,body:{error:'No fixture route'}};
    }});sites.push(service);return service;
  }
  try{const work=await site('work','group/subgroup/web'),personal=await site('personal','personal/server');return {work,personal,flags,observed,sites,
    hold(profile,number){if(flags.hold)throw Error('A fixture detail is already held');let release;const hold={profile,number,entered:false,promise:new Promise(resolve=>release=resolve),release:()=>{release();if(flags.hold===hold)flags.hold=null;}};flags.hold=hold;return hold;},
    async close(){flags.hold?.release();for(const hold of pending)hold.release();for(const service of [...sites].reverse())await service.close();}
  };}catch(error){for(const service of sites.reverse())await service.close();throw error;}
}
function configuration(runtime,fixtures,remote){
  const config=newConfig(),local={machine:null,repoRoot:runtime.repo,gitlab:{connectionId:'work',projectPath:'group/subgroup/web',status:{labels:{todo:['todo'],inProgress:['doing'],done:['done']}}}},server={machine:remote.machine,repoRoot:remote.repo,gitlab:{connectionId:'personal',projectPath:'personal/server'}};
  config.connections={work:{id:'work',kind:'api',site:fixtures.work.origin,auth:{kind:'bearer',tokenEnv:'QA_GITLAB_WORK'}},personal:{id:'personal',kind:'api',site:fixtures.personal.origin,auth:{kind:'bearer',tokenEnv:'QA_GITLAB_PERSONAL'}}};config.bindings={[bindingKey(null,runtime.repo)]:local,[bindingKey(server.machine,server.repoRoot)]:server};config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree:true,tools:{}};return config;
}

async function actors(runtime){
  const directory=path.join(runtime.directory,'actor-input');await fs.mkdir(directory);const programs={};
  for(const key of ['claude','codex','grok']){
    const file=path.join(runtime.directory,'qa-'+key);
    await fs.writeFile(file,`#!/usr/bin/env python3
import os,sys,time,json,select,tty
if '--help' in sys.argv: print('QA ${key}\\nUsage: ${key} [OPTIONS] [PROMPT]\\n --model <MODEL>');sys.exit(0)
if '--version' in sys.argv: print('Native GitLab fixture 1.0');sys.exit(0)
directory=${JSON.stringify(directory)}
record={'tool':'${key}','pid':os.getpid(),'cwd':os.getcwd(),'argv':sys.argv[1:],'received':''}
file=os.path.join(directory,str(os.getpid())+'.json')
def save():
 temporary=file+'.next'
 with open(temporary,'w') as output: json.dump(record,output)
 os.replace(temporary,file)
if sys.stdin.isatty(): tty.setraw(sys.stdin.fileno())
save()
print('Disposable GitLab native actor; no provider call.',flush=True)
while True:
 print('\\x1b]7501;state=idle:app=${key==='claude'?'claude-code':key}\\x1b\\\\',end='',flush=True)
 ready,_,_=select.select([sys.stdin],[],[],3)
 if ready:
  chunk=os.read(sys.stdin.fileno(),65536)
  if not chunk: break
  record['received']=(record['received']+chunk.decode('utf-8',errors='replace'))[:131072]
  save()
`);await fs.chmod(file,0o700);programs[key]={name:'QA '+key,run:[file]};
  }
  await fs.writeFile(path.join(runtime.env.HERDR_APP_HOME,'programs.json'),JSON.stringify({programs}));
  return {programs,directory,async read(){const values=[];for(const name of await fs.readdir(directory))if(/^[0-9]+\.json$/.test(name))values.push(JSON.parse(await fs.readFile(path.join(directory,name),'utf8')));return values;}};
}

async function helper(home,env,input){const result=await execute(process.execPath,[path.join(home,'mods',MOD,'backend.mjs'),JSON.stringify(input)],{env,maxBuffer:8*1024*1024,timeout:28000});assert.equal(result.stderr,'');return JSON.parse(result.stdout);}

async function positionWindow(runtime,{compileOnly=false}={}){
  const source=path.join(runtime.directory,'gitlab-position.swift'),binary=path.join(runtime.directory,'gitlab-position');
  await fs.writeFile(source,String.raw`import Cocoa
import ApplicationServices
let pid=Int32(CommandLine.arguments[1])!
func fail(_ message:String)->Never {FileHandle.standardError.write(message.data(using:.utf8)!);exit(2)}
guard let application=NSRunningApplication(processIdentifier:pid) else {fail("Owned app is unavailable")}
application.activate()
var raw:CFTypeRef?
guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),kAXWindowsAttribute as CFString,&raw) == .success,let windows=raw as? [AXUIElement] else {fail("Owned AX windows unavailable")}
let main=windows.filter {window in
 var value:CFTypeRef?
 guard AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&value) == .success,let v=value,CFGetTypeID(v)==AXValueGetTypeID() else {return false}
 var size=CGSize.zero
 return AXValueGetValue(v as! AXValue,.cgSize,&size) && size.width>=800 && size.height>=600
}
guard main.count==1 else {fail("A unique owned main window is required")}
var actual:pid_t=0
AXUIElementGetPid(main[0],&actual)
guard actual==pid else {fail("Owned AX PID changed")}
var full:CFTypeRef?
if AXUIElementCopyAttributeValue(main[0],"AXFullScreen" as CFString,&full) == .success,let enabled=full as? Bool,enabled {
 guard AXUIElementSetAttributeValue(main[0],"AXFullScreen" as CFString,kCFBooleanFalse) == .success else {fail("Owned fullscreen exit failed")}
 print(#"{"retry":true}"#);exit(0)
}
var size=CGSize(width:1280,height:760),point=CGPoint(x:300,y:350)
guard let s=AXValueCreate(.cgSize,&size),let p=AXValueCreate(.cgPoint,&point),AXUIElementSetAttributeValue(main[0],kAXSizeAttribute as CFString,s) == .success,AXUIElementSetAttributeValue(main[0],kAXPositionAttribute as CFString,p) == .success else {fail("Owned window positioning failed")}
_ = AXUIElementPerformAction(main[0],kAXRaiseAction as CFString)
let all=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let owned=all.filter {record in
 guard (record[kCGWindowOwnerPID as String] as? Int)==Int(pid),(record[kCGWindowLayer as String] as? Int)==0,let b=record[kCGWindowBounds as String] as? [String:Any],let r=CGRect(dictionaryRepresentation:b as CFDictionary) else {return false}
 return r.width>=800 && r.height>=600
}
guard owned.count==1,let id=owned[0][kCGWindowNumber as String] as? Int else {fail("A unique owned visible window is required")}
let data=try! JSONSerialization.data(withJSONObject:["windowId":id]);FileHandle.standardOutput.write(data)
`);
  run('swiftc',['-module-cache-path',path.resolve('.harness/swift-cache'),source,'-o',binary],{json:false,timeout:60000});
  if(compileOnly)return binary;
  await until(async()=>{const result=run(binary,[String(runtime.owner.pid)]);if(result.retry)return false;const frame=await runtime.driver.bindWindow(result.windowId);return Math.abs(frame.width-1280)<2&&Math.abs(frame.height-760)<2&&Math.abs(frame.x-300)<2&&Math.abs(frame.y-350)<2;},'owned GitLab window position and native input bounds');
}

async function wrapDiagnostic(runtime){const directory=path.join(runtime.env.HERDR_APP_HOME,'mods',MOD);await fs.rename(path.join(directory,'main.js'),path.join(directory,'compiled.js'));await fs.writeFile(path.join(directory,'main.js'),`import Original from './compiled.js';import {div} from 'gpui-kit';import * as herdr from 'herdr';
export default class Diagnostic extends Original {spawn(cx,work){this.debugJobs??=new Map();for(const[job]of this.debugJobs)if(job.is_done())this.debugJobs.delete(job);const job=super.spawn(cx,work);let label='';try{label=String(work).slice(0,160);}catch{}this.debugJobs.set(job,label);return job;}render(cx){const root=super.render(cx);return root.child(div().absolute().top(0).right(4).w(64).h(22).bg('#293443').text_color('#ffffff').text_size(10).child('Inspect').on_click((_e,eventCx)=>{herdr.setShared('gitlab-private-diagnostic',{role:this.role,embedded:!!this.props.hideHeader,error:this.error,closed:this.closed,contextEpoch:this.contextEpoch,resolved:this.resolved?.state,slots:this.slots?.size,tools:this.tools?.size,data:{state:this.data?.view()?.state,rows:this.data?.view()?.data?.length,bindings:this.data?.view()?.bindings?.length,loading:this.data?.view()?.loading,phase:this.data?.phase,generation:this.data?.generation},board:{requested:this.board?.requested?.epoch,ready:this.board?.ready?.records?.length,pool:this.board?.pool?.size,retained:this.board?.retained?.size},jobs:this.jobs.map(job=>({done:job.is_done(),work:this.debugJobs?.get(job)||''}))});eventCx.notify();}));}}`);runtime.app(['check',directory],{json:false});}

export default async function gitlab(runtime){
  const home=runtime.env.HERDR_APP_HOME,configFile=path.join(home,'mission-control/config.json'),server=new NativeRuntime();let fixtures,connected=false;
  try{
    fixtures=await gitlabFixtures(runtime.directory);await fs.writeFile(CA,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    const actor=await actors(runtime);await server.start();
    const via=path.join(runtime.directory,'gitlab-via.py'),selectors=Object.fromEntries(Object.entries(server.env).filter(([key])=>['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'].includes(key)));
    await fs.writeFile(via,`#!/usr/bin/env python3\nimport os,sys,json\ne=os.environ.copy();e.update(json.loads(${JSON.stringify(JSON.stringify(selectors))}))\nos.execvpe('/bin/sh',['sh','-c',sys.argv[-1]],e)\n`);await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name','qa-server','--session',server.env.HC_SESSION,'--json']);connected=true;
    const config=configuration(runtime,fixtures,{machine:'qa-server',repo:server.repo});await fs.mkdir(path.dirname(configFile),{recursive:true});await fs.writeFile(configFile,JSON.stringify(config));
    await runtime.installPackage(MOD);if(runtime.diagnosticWrapped)await wrapDiagnostic(runtime);const workBinding=config.bindings[bindingKey(null,runtime.repo)],personalBinding=config.bindings[bindingKey('qa-server',server.repo)];
    for(const binding of [workBinding,personalBinding]){const reply=await helper(home,runtime.env,{v:1,operation:'issues',connection:config.connections[binding.gitlab.connectionId],binding});runtime.expect(reply.ok&&reply.snapshot.data.length===3,'Copied standalone helper reads all owned '+binding.gitlab.connectionId+' issues without Jira');}
    const linked=path.join(runtime.directory,'linked-checkout');run('git',['-C',runtime.repo,'worktree','add','-q','-b','qa-linked',linked],{env:runtime.env,json:false});await fs.writeFile(path.join(linked,'linked.md'),'Captured linked checkout HEAD\n');run('git',['-C',linked,'add','linked.md'],{env:runtime.env,json:false});run('git',['-C',linked,'commit','-qm','Advance linked fixture'],{env:runtime.env,json:false});const linkedHead=run('git',['-C',linked,'rev-parse','HEAD'],{env:runtime.env,json:false});
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[300,350,1280,760]}));
    const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
    await runtime.startWindow({name:'gitlab-native',layout:{id:'qa-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',children:[block('tabs','tabs',42),{id:'workspace',type:'row',children:[{id:'tracker',type:'stack',size:{weight:3},active:'issues',children:[block('issues',MOD,null,{view:'issues'}),block('merges',MOD,null,{view:'merges'}),block('embedded-issues',MOD,null,{view:'issues',hideHeader:true}),block('embedded-merges',MOD,null,{view:'merges',hideHeader:true})]},{id:'terminal',type:'block',size:{px:280},content:{tab:'active'}}]},block('status','workspace-status',26)]}});
    await positionWindow(runtime);const remote=await until(()=>runtime.app(['ls']).spaces.find(s=>s.machine==='qa-server'),'GitLab remote fixture space adoption');runtime.app(['do','space.rename',JSON.stringify({id:remote.id,name:'server-repo'})]);runtime.app(['do','space.rename',JSON.stringify({id:runtime.spaceId,name:'client-portal'})]);
    const linkedTab=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:linked,argv:actor.programs.claude.run})]);
    const focusLocal=()=>{runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','pane.focus',JSON.stringify({terminal:linkedTab.terminal})]);};focusLocal();
    let serial=0,role='issues';const observe=async(query='')=>{if(++serial>400)throw Error('Native GitLab observation budget exhausted');const frame=await runtime.frame('gitlab-observe-'+serial),observation=await runtime.driver.ocr(path.resolve(frame.path),query);if(observation.lines.some(n=>/\binterrupted\b|render.*error|could not complete this action/i.test(n.text)))throw Error('Native GitLab render/action error banner: '+observation.lines.map(n=>n.text).join(' | '));return observation;};
    const inBoard=(n,o)=>n.frame.x<o.window.width-280&&n.frame.y>80&&n.frame.y<o.window.height-35;
    const text=(query,predicate=inBoard)=>until(async()=>{const o=await observe(query),matches=o.matches.filter(n=>n.confidence>=0.6&&predicate(n,o));return matches.length===1?{observation:o,node:matches[0]}:null;},'visible unique GitLab text '+query);
    const click=async(query,predicate)=>{const {observation,node}=await text(query,predicate);await runtime.driver.clickObservedText(observation,node);};
    const has=async query=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.6&&inBoard(n,o));};
    // One screen read can miss text that is there; positive checks re-read briefly before failing.
    const eventually=check=>until(async()=>await check()?true:null,'visible GitLab text',10000).catch(()=>false);
    const state=async()=>(await runtime.shared())[role==='merges'?MERGES:ISSUES];
    const search=async value=>{
      focusLocal();let prior=null,target;
      // A completed tab can still be applying focus/launch status. Wait for
      // the real search control to stop moving before typing into that point.
      await until(async()=>{const old=(await state())?.query||'Search '+(role==='merges'?'merge requests':'issues'),next=await text(old,(n,o)=>inBoard(n,o)&&n.frame.y<155&&n.frame.x>150),box=JSON.stringify(next.node.frame);if(box===prior){target=next;return true;}prior=box;return false;},'stable native GitLab search control');
      const {observation,node}=target;await runtime.driver.clickObservedText(observation,node);await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await until(async()=>((await state())?.query??'')==='','cleared native GitLab search');
      // Observe each user-paced input chunk. Fast injected text can overrun
      // native key delivery while the first filtered frame is being laid out.
      let typed='';for(let index=0;index<value.length;index+=4){const chunk=value.slice(index,index+4);await runtime.driver.bridge('type',chunk);typed+=chunk;runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:'GitLab search',characters:chunk.length,observation:observation.source});await until(async()=>((await state())?.query??'')===typed,'native GitLab query chunk '+typed);}
    };

    const toolbar=async name=>{const query=(await state())?.query||'Search '+(role==='merges'?'merge requests':'issues'),{observation,node}=await text(query,(n,o)=>inBoard(n,o)&&n.frame.y<155&&n.frame.x>150),width=observation.window.width-280;await runtime.driver.click({x:width-(name==='refresh'?73:42),y:node.frame.y+node.frame.height/2-14,width:28,height:28},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'GitLab '+name,observation:observation.source});};
    const selectView=async view=>{runtime.app(['do','layout.select',JSON.stringify({stack:'tracker',child:view})]);role=view;await text(view==='merges'?'Merge requests':'GitLab',(n,o)=>n.frame.x<o.window.width-280&&n.frame.y>42&&n.frame.y<80);};
    const journal=async()=>{try{return Object.values(JSON.parse(await fs.readFile(path.join(home,'mission-control/launches.json'),'utf8')).requests);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
    const completed=async(source,connectionId='work')=>until(async()=>{const rows=await journal();return rows.find(r=>r.state==='complete'&&r.request.source.id===source&&r.request.source.connectionId===connectionId);},'actual acknowledged native launch '+source);
    const received=async(record,action)=>until(async()=>{const raw=(await actor.read()).find(row=>row.tool===record.request.toolKey&&row.cwd===record.folder);return raw&&(raw.argv.join('\n')+'\n'+raw.received).includes('Mission Control action: '+action)?raw:null;},'task received by disposable '+record.request.toolKey+' actor');
    const issueIcon=async(key,index)=>{const {observation,node}=await text(key,(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90),width=observation.window.width-280,padding=width<768?10:14,columnWidth=width<768?Math.min(460,width-2*padding):Math.min(360,(width-2*padding-24)/3),left=node.frame.x-11;await runtime.driver.click({x:left+columnWidth-10-106+index*27,y:node.frame.y-1+14+7+36+7+1,width:25,height:25},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'GitLab issue '+key+' agent '+index,observation:observation.source});};
    // Details load asynchronously above the action row and keep the start icons disabled until loaded:
    // click only once no card shows Loading… and the row's position holds for two frames.
    // The 26 pt target starts 20 pt below the action labels' centre, so its centre is on the tool-icon row.
    const mrIcon=async index=>{let prior=null,steady=null;await until(async()=>{const hit=await text('Address comments',(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90),box=JSON.stringify(hit.node.frame);if(hit.observation.lines.some(l=>/^Loading/.test(l.text.trim())&&inBoard(l,hit.observation))){prior=null;return false;}if(box===prior){steady=hit;return true;}prior=box;return false;},'steady MR action row with details loaded');const {observation,node}=steady,right=observation.window.width-280-14;await runtime.driver.click({x:right-11-110+index*28,y:node.frame.y+node.frame.height/2+20,width:26,height:26},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Selected MR agent '+index,observation:observation.source});};
    const closeOverlay=async()=>{await runtime.driver.press('escape');await until(()=>!runtime.app(['status']).overlays.length,'closed GitLab own-mod dialog');};
    const sourceOpened=async url=>{
      assert.ok([fixtures.work.origin,fixtures.personal.origin].some(origin=>url.startsWith(origin+'/')),'Only the owned fixture URL may be observed or closed');
      const script=close=>['set found to false',...['Google Chrome','Safari'].flatMap(browser=>[`if application "${browser}" is running then`,`tell application "${browser}"`,'repeat with w in windows','repeat with t in tabs of w',`if URL of t is ${JSON.stringify(url)} then`,'set found to true',...(close?['close t']:[]),'end if','end repeat','end repeat','end tell','end if']),'return found'].join('\n');
      await until(()=>run('osascript',['-e',script(false)],{json:false})==='true','exact captured source URL in the actual system browser');run('osascript',['-e',script(true)],{json:false});await positionWindow(runtime);
    };
    const writeConfig=async mutate=>{const next=JSON.parse(await fs.readFile(configFile,'utf8'));mutate(next);next.revision++;await fs.writeFile(configFile,JSON.stringify(next));return next;};
    const field=async(title,value,{right=false}={})=>{
      let target;for(let attempt=0;attempt<8;attempt++){
        const observation=await observe(title),matches=observation.matches.filter(n=>n.confidence>=0.6&&n.text===title&&n.frame.x>observation.window.width/2-340&&n.frame.x<observation.window.width/2-180&&n.frame.y>50&&n.frame.y<observation.window.height-100);
        if(matches.length===1){target={observation,node:matches[0]};break;}
        await runtime.driver.scroll({x:observation.window.width/2+230,y:observation.window.height/2,width:8,height:8},-350,{expectedSize:observation.window});
      }
      if(!target)throw Error('GitLab setup field is unavailable: '+title);const {observation,node}=target;
      await runtime.driver.click({x:right?observation.window.width/2+24:node.frame.x+20,y:node.frame.y+node.frame.height+9,width:150,height:20},{expectedSize:observation.window});await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await runtime.driver.bridge('type',value);runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:title,characters:value.length,observation:observation.source});
    };

    let o;console.log('GitLab native: issue setup, direct links and workflow');await text('GL-142');await text('GL-156');await text('GL-168');runtime.expect(await has('To do')&&await has('In progress')&&await has('Done'),'Mounted GitLab issue cards show the three configured workflow groups without a Jira connection');
    await toolbar('settings');await text('GitLab connection',(n,o)=>n.frame.x>o.window.width/2-340&&n.frame.x<o.window.width/2+340&&n.frame.y<120);await click('New profile',(n,o)=>n.text==='New profile'&&n.frame.x>o.window.width/2-340&&n.frame.x<o.window.width/2+340);await field('Profile ID','gitlab-native');await field('GitLab site',fixtures.work.origin);await field('Token environment variable','QA_GITLAB_WORK');await click('Save connection',(n,o)=>n.frame.y>50);await until(()=>!runtime.app(['status']).overlays.length,'native GitLab setup probe and save');
    const saved=JSON.parse(await fs.readFile(configFile,'utf8'));runtime.expect(saved.bindings[bindingKey(null,runtime.repo)].gitlab.connectionId==='gitlab-native'&&saved.connections['gitlab-native'].auth.tokenEnv==='QA_GITLAB_WORK','Mounted GitLab setup validates the project and persists a credential variable reference');await writeConfig(value=>{value.connections=config.connections;value.bindings=config.bindings;value.preferences=config.preferences;});await toolbar('refresh');await text('GL-142');
    await click('GL-168');await sourceOpened(fixtures.work.origin+'/group/subgroup/web/-/issues/168');runtime.expect(true,'Native GitLab issue key opens the captured source URL in the browser');
    await click('Done',(n,o)=>inBoard(n,o)&&n.frame.y>130&&n.frame.y<170);await until(async()=>(await state())?.status==='done','native GitLab Done filter');runtime.expect(await has('GL-168')&&!(await has('GL-142')),'Native Done filter removes other issue groups');await click('All',(n,o)=>inBoard(n,o)&&n.frame.y>130&&n.frame.y<170);await search('settings');runtime.expect(await has('GL-156')&&!(await has('GL-142')),'Native GitLab issue search filters compact cards');await search('');
    await issueIcon('GL-142',0);const issue=await completed('10142');runtime.expect(issue.request.checkoutRoot===linked&&path.basename(issue.folder)==='client-portal-GL-142','One-click issue launch keeps the linked checkout and workspace-plus-issue worktree name');runtime.expect(run('git',['-C',issue.folder,'rev-parse','HEAD'],{env:runtime.env,json:false})===linkedHead,'Real issue worktree starts from the captured linked checkout HEAD');

    console.log('GitLab native: 120-MR pagination, retained cards and offscreen links');await selectView('merges');focusLocal();await search('');await text('Review reconnect handling',(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90);fixtures.flags.large=true;const paginationStart=fixtures.observed.length;await toolbar('refresh');await text('60 / 120 loaded');runtime.expect(await has('Scale test MR 1000')&&!(await has('Scale test MR 1119')),'Native MR list initially exposes 60 of 120 records with later cards offscreen');await click('Show more');await text('120 / 120 loaded');
    let last;for(let attempt=0;attempt<24;attempt++){const observation=await observe('Scale test MR 1119'),matches=observation.matches.filter(n=>n.confidence>=0.6&&inBoard(n,observation));if(matches.length===1){last={observation,node:matches[0]};break;}for(let step=0;step<6;step++)await runtime.driver.scroll({x:observation.window.width-320,y:observation.window.height/2,width:8,height:8},-2000,{expectedSize:observation.window});}assert.ok(last,'An offscreen MR must become visible through actual native list scrolling');await runtime.driver.clickObservedText(last.observation,last.node);await sourceOpened(fixtures.work.origin+'/group/subgroup/web/-/merge_requests/1119');
    const pages=fixtures.observed.slice(paginationStart).filter(r=>r.large&&r.profile==='work'&&r.path.endsWith('/merge_requests'));runtime.expect([1,2,3].every((page,index)=>pages.some(r=>r.page===page&&r.perPage===50&&r.returned===[50,50,20][index])),'Native 120-MR source uses real GitLab page headers and 50/50/20 results');runtime.expect(true,'Show more and native scrolling expose interactive offscreen MR cards without host-budget changes');fixtures.flags.large=false;await toolbar('refresh');await search('Review reconnect handling');

    console.log('GitLab native: exact MR actions, independent metadata and reuse');await click('Details');await text('Pipeline failed');runtime.expect(await has('Review unavailable')&&await has('1 unresolved'),'Approval denial does not hide readable discussions or failed-pipeline metadata');runtime.expect(await eventually(()=>has('#142')),'MR linked issue displays its human issue number');await click('#142');await sourceOpened(fixtures.work.origin+'/group/subgroup/web/-/issues/142');
    const toolbarBefore=(await text('Review reconnect handling',(n,o)=>inBoard(n,o)&&n.frame.y<155&&n.frame.x>150)).node.frame;
    await mrIcon(0);const review=await completed(sourceId('work',42)),reviewInput=await received(review,'Review merge request');runtime.expect(review.request.checkoutRoot===linked&&review.request.source.key==='GL-MR-42'&&review.request.source.id===sourceId('work',42),'Review launch preserves linked checkout, opaque global MR id and readable display key');
    await text('Review started.');const toolbarAfter=(await text('Review reconnect handling',(n,o)=>inBoard(n,o)&&n.frame.y<155&&n.frame.x>150)).node.frame;runtime.expect(Math.abs((toolbarBefore.y+toolbarBefore.height)-(toolbarAfter.y+toolbarAfter.height))<2&&Math.abs(toolbarBefore.x-toolbarAfter.x)<2,'Action feedback preserves the native search text baseline');
    const beforeReuse=(await actor.read()).length,inputBefore=(await actor.read()).find(row=>row.pid===reviewInput.pid).received;for(const action of ['Fix checks','Address comments']){await click(action,(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90);await text('Open agent');
      // A repeat start only refocuses the existing agent, so a click the window dropped can safely be repeated.
      for(let attempt=0;;attempt++){await mrIcon(0);const seen=await until(async()=>{const o=await observe('No new task was sent.');return o.matches.some(n=>n.confidence>=0.6&&inBoard(n,o))?true:null;},'reuse notice',15000).catch(()=>null);if(seen)break;if(attempt>=2)await text('No new task was sent.');}}await delay(300);runtime.expect((await actor.read()).length===beforeReuse&&(await actor.read()).find(row=>row.pid===reviewInput.pid).received===inputBefore,'Review followed by both code actions on the same MR/tool focuses one actual agent and sends no second task');
    for(const [query,action,index,number,prefix]of [['Address redirect comments','Address comments',1,43,'Address review comments'],['Repair failing pipeline','Fix checks',2,44,'Fix failing pipeline']]){focusLocal();await search(query);await click(action,(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90);await mrIcon(index);const record=await completed(sourceId('work',number)),input=await received(record,prefix);runtime.expect(record.request.checkoutRoot===linked&&record.request.repoRoot===runtime.repo,'Mounted '+prefix+' reaches its selected tool from the captured linked checkout');runtime.expect((input.argv.join('\n')+'\n'+input.received).includes(number===43?'Handle the expired cookie.':'login-tests'),'Actual '+prefix+' task contains captured actionable provider evidence');}
    await search('Inspect contributor fork');await click('Details');await text('Pipeline failed');await click('Fix checks',(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90);await mrIcon(0);await received(await completed(sourceId('work',45)),'Review merge request');runtime.expect(true,'Fork review remains enabled in the bound checkout while disabled fix controls cannot change the action');
    await search('Locked patch');const beforeLocked=(await actor.read()).length;await mrIcon(0);await delay(250);runtime.expect((await actor.read()).length===beforeLocked&&!(await journal()).some(r=>r.request.source.id===sourceId('work',46)),'Locked MR shortcuts have no native launch effects');
    await search('Empty partial discussions');await click('Details');await until(async()=>{const observation=await observe();return observation.lines.some(n=>n.confidence>=0.6&&inBoard(n,observation)&&/unresolved.*partial/i.test(n.text));},'visible partial discussion evidence');await click('Address comments',(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90);await mrIcon(0);await received(await completed(sourceId('work',47)),'Review merge request');runtime.expect(true,'Incomplete empty discussion evidence cannot select the comments action');
    await search('Partial captured comments');await click('Details');await until(async()=>{const observation=await observe();return observation.lines.some(n=>n.confidence>=0.6&&inBoard(n,observation)&&/unresolved.*partial/i.test(n.text));},'visible partial discussion evidence');await click('Address comments',(n,o)=>inBoard(n,o)&&n.frame.y>170&&n.frame.y<o.window.height-90);await mrIcon(1);const partial=await received(await completed(sourceId('work',48)),'Address review comments');runtime.expect((partial.argv.join('\n')+'\n'+partial.received).includes('Partial comment evidence'),'Partial nonempty evidence is marked visibly and delivered truthfully despite denied approvals');
    await search('Restricted review threads');await click('Details');await text('Pipeline failed');runtime.expect(await eventually(()=>has('Threads unavailable')),'Discussion denial does not conceal independently readable failed-pipeline metadata');

    console.log('GitLab native: held cross-host action, closed slots and standalone packaging');await search('');await click('All spaces',(n,o)=>inBoard(n,o)&&n.frame.y<140);await until(async()=>(await state())?.all===true,'mounted MR All-spaces scope');await search('Server: Review reconnect handling');const held=fixtures.hold('personal',42);focusLocal();await mrIcon(1);await until(()=>held.entered,'remote clicked MR detail actually pending');runtime.app(['do','space.select',JSON.stringify({id:remote.id})]);focusLocal();await click('This space',(n,o)=>inBoard(n,o)&&n.frame.y<140);await until(async()=>(await state())?.all===false,'held remote MR source removed from visible scope');held.release();const remoteRecord=await completed(sourceId('personal',42),'personal');await received(remoteRecord,'Review merge request');const remoteRaw=server.hc(['get',localTerminalAddress(remoteRecord.ack.terminal,'qa-server'),'--json']);runtime.expect(remoteRecord.request.spaceId===remote.id&&remoteRecord.request.machine==='qa-server'&&remoteRecord.request.repoRoot===server.repo&&remoteRecord.request.checkoutRoot===server.repo&&remoteRecord.request.source.connectionId==='personal'&&remoteRaw.cwd===remoteRecord.folder,'Held MR action survives scope/focus changes and reaches project B on the separate positively owned core');
    focusLocal();await search('Repair failing pipeline');runtime.app(['do','tab.close',JSON.stringify({id:(await completed(sourceId('work',44))).ack.tab,confirmed:true})]);await text('Resume from history');const beforeClosed=(await actor.read()).length;
    // Pointing a closed slot at its history starts nothing, so a dropped click can be repeated.
    for(let attempt=0;;attempt++){await mrIcon(2);const seen=await until(async()=>{const o=await observe('exact session from history');return o.matches.some(n=>n.confidence>=0.6&&inBoard(n,o))?true:null;},'history notice',15000).catch(()=>null);if(seen)break;if(attempt>=2)await text('exact session from history');}runtime.expect((await actor.read()).length===beforeClosed,'Closed MR slot points to exact-session history and cannot recreate the agent');
    // The overflow stays disabled while the selected action's details load; click again only while no dialog is open.
    await search('Review reconnect handling');await until(async()=>{if(!runtime.app(['status']).overlays.includes(MOD)){await mrIcon(3);await new Promise(resolve=>setTimeout(resolve,1500));}return runtime.app(['status']).overlays.includes(MOD);},'MR overflow dialog once its action is available',45000);await text('New agent',(n,o)=>n.frame.x>o.window.width/2-300&&n.frame.x<o.window.width/2+300&&n.frame.y>40&&n.frame.y<180);runtime.expect(runtime.app(['status']).overlays.includes(MOD),'MR overflow opens the standalone mod’s own agent/worktree dialog');await closeOverlay();
    await selectView('issues');focusLocal();await text('GL-142');fixtures.flags.denyWork=true;await toolbar('refresh');await text('cannot read');runtime.expect(await has('GL-142')&&await has('Cached'),'Provider failure keeps timestamped real issue cards with explicit cached state');fixtures.flags.denyWork=false;
    await writeConfig(value=>{value.connections.missing={...value.connections.work,id:'missing',auth:{kind:'bearer',tokenEnv:'QA_GITLAB_NEVER_CONFIGURED'}};value.bindings[bindingKey(null,runtime.repo)].gitlab.connectionId='missing';});await toolbar('refresh');await text('credentials are unavailable');runtime.expect(!(await has('GL-142')),'Rebinding to missing credentials clears previous-account issue cards');await writeConfig(value=>{value.connections=config.connections;value.bindings=config.bindings;});await toolbar('refresh');await text('GL-142');
    // Embedded roles use the same source with the heading suppressed.
    for(const view of ['issues','merges']){runtime.app(['do','layout.select',JSON.stringify({stack:'tracker',child:'embedded-'+view})]);role=view;await text(view==='issues'?'GL-142':'Review reconnect handling');const observation=await observe(view==='issues'?'GitLab':'Merge requests');runtime.expect(!observation.matches.some(n=>n.confidence>=0.6&&n.frame.x<120&&n.frame.y>=42&&n.frame.y<80),'Embedded '+view+' suppresses the duplicate provider heading');}
    await selectView('merges');focusLocal();await search('');await text('Review reconnect handling');runtime.expect(runtime.app(['status']).errors.length===0,'Standalone issue/MR/embedded/dialog workflows produce zero native app errors');runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(n=>n.startsWith('mission-control-')).join(',')===MOD,'Only this standalone custom mod is installed; Jira and other Mission Control mods are absent');runtime.expect(fixtures.observed.filter(r=>r.path.startsWith('/api/')).every(r=>r.method==='GET'),'The owned provider evidence contains no mutation requests');await runtime.frame('gitlab-preview');
    // Preview promotion happens only after the harness validates its receipt
    // and positively verifies cleanup. Failed runs leave no public preview.
  }catch(error){
    const directory=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'gitlab-fixture-requests.json'),JSON.stringify(fixtures?.observed||[],null,2));await fs.writeFile(path.join(directory,'gitlab-native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));try{await fs.copyFile(path.join(home,'mission-control/launches.json'),path.join(directory,'gitlab-failure-launches.json'));}catch{}if(runtime.diagnosticWrapped)try{const frame=await runtime.frame('gitlab-diagnostic-failure'),observation=await runtime.driver.ocr(path.resolve(frame.path),'Inspect'),matches=observation.matches.filter(n=>n.confidence>=0.6&&n.frame.x>observation.window.width-380&&n.frame.x<observation.window.width-280&&n.frame.y<120);if(matches.length===1){await runtime.driver.clickObservedText(observation,matches[0]);await delay(200);await fs.writeFile(path.join(directory,'gitlab-diagnostic-state.json'),JSON.stringify((await runtime.shared())['gitlab-private-diagnostic'],null,2));}}catch{}try{await fs.writeFile(path.join(directory,'gitlab-failure-status.json'),JSON.stringify(runtime.app(['status']),null,2));await runtime.frame('gitlab-failure');}catch{}throw error;
  }finally{await fixtures?.close();if(connected)runtime.hc(['machine','rm','qa-server','--json']);if(server.directory)await server.close();}
}

/** Only the copied helper, synthetic TLS sites and disposable tool actors. */
export async function checkFixtures(){
  const directory=await fs.mkdtemp('/private/tmp/mcqa-'),home=path.join(directory,'app');let fixtures;
  try{
    fixtures=await gitlabFixtures(directory);await fs.mkdir(path.join(home,'mods'),{recursive:true});const built=await buildPackage(MOD);await fs.cp(built.directory,path.join(home,'mods',MOD),{recursive:true});const ca=path.join(directory,'both.pem');await fs.writeFile(ca,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    const env=isolatedEnvironment(directory,crypto.randomBytes(12).toString('hex'),process.env,{...fixtureEnvironment,NODE_EXTRA_CA_CERTS:ca});for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'])await fs.mkdir(env[key],{recursive:true,mode:0o700});
    const config=configuration({repo:'/fixture/local'},fixtures,{machine:'qa-server',repo:'/fixture/server'}),bindings=Object.values(config.bindings),input=(binding,operation)=>({v:1,operation,binding,connection:config.connections[binding.gitlab.connectionId]});let assertions=0;
    for(const binding of bindings){const issues=await helper(home,env,input(binding,'issues'));assert.equal(issues.ok,true,JSON.stringify(issues));assert.deepEqual(issues.snapshot.data.map(i=>i.statusGroup),binding.machine?['todo','todo','done']:['todo','inProgress','done']);assertions++;const list=await helper(home,env,input(binding,'merges'));assert.equal(list.ok,true,JSON.stringify(list));assert.equal(list.snapshot.data.length,11);assertions++;
      for(const[number,check]of [[42,m=>m.review.reason==='APPROVALS_UNAVAILABLE'&&mrActionAvailability(m,'review').enabled],[43,m=>m.review.reason==='APPROVALS_UNAVAILABLE'&&mrActionAvailability(m,'addressComments').enabled],[44,m=>mrActionAvailability(m,'addressComments').reason==='NO_ACTIONABLE_COMMENTS'&&mrActionAvailability(m,'fixChecks').enabled],[45,m=>mrActionAvailability(m,'review').enabled&&mrActionAvailability(m,'fixChecks').reason==='FORK_READ_ONLY'],[46,m=>mrActionAvailability(m,'review').reason==='MR_LOCKED'],[47,m=>mrActionAvailability(m,'addressComments').reason==='DISCUSSIONS_PARTIAL'],[48,m=>!m.discussions.complete&&m.actionContext.comments.notes.length===1&&mrActionAvailability(m,'addressComments').enabled],[49,m=>m.discussions.reason==='DISCUSSIONS_UNAVAILABLE'],[50,m=>m.state==='closed'],[51,m=>m.state==='merged'],[52,m=>m.draft]]){const selected=list.snapshot.data.find(m=>m.identity.number===number),reply=await helper(home,env,{...input(binding,'merges'),cursor:mrDetailCursor(selected)});assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(check(reply.snapshot.data[0]),true,'Native fixture case '+number);assertions++;}
    }
    fixtures.flags.large=true;const start=fixtures.observed.length,large=await helper(home,env,input(bindings[0],'merges'));assert.equal(large.ok,true,JSON.stringify(large));assert.equal(large.snapshot.data.length,120);assert.deepEqual(fixtures.observed.slice(start).filter(r=>r.large).map(r=>[r.page,r.perPage,r.returned]),[[1,50,50],[2,50,50],[3,50,20]]);assertions+=2;fixtures.flags.large=false;
    const hold=fixtures.hold('personal',42),list=await helper(home,env,input(bindings[1],'merges')),pending=helper(home,env,{...input(bindings[1],'merges'),cursor:mrDetailCursor(list.snapshot.data[0])});await until(()=>hold.entered,'owned fixture delayed detail');hold.release();assert.equal((await pending).ok,true);assertions++;
    fixtures.flags.denyWork=true;assert.equal((await helper(home,env,input(bindings[0],'issues'))).error.code,'PERMISSION_DENIED');fixtures.flags.denyWork=false;assertions++;assert.ok(fixtures.observed.filter(r=>r.path.startsWith('/api/')).every(r=>r.authorized&&r.method==='GET'));assertions++;
    const actor=await actors({directory,env:{HERDR_APP_HOME:home}});for(const program of Object.values(actor.programs)){const result=await execute(program.run[0],['--help'],{env});assert.ok(result.stdout.includes('--model'));assert.ok(!result.stdout.includes('--instructions'));assertions++;}await positionWindow({directory},{compileOnly:true});assertions++;
    return {ok:true,assertions,boundary:'Synthetic GitLab sites, copied standalone helper and tool actors only; no Herdr app/core constructed, queried or stopped and no preview or native success receipt written.'};
  }finally{await fixtures?.close();await fs.rm(directory,{recursive:true,force:true});}
}
/** Negative setup proof never writes a releasable receipt or public preview. */
export async function checkEmptySetup(){
  let publicReceiptUnchanged=false,publicPreviewUnchanged=false;const runtime=new NativeRuntime(),receiptFile=path.resolve('evidence/native/gitlab.json'),previewFile=path.resolve(MOD,'preview.png');let failure;
  const read=async file=>{try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}},before={receipt:await read(receiptFile),preview:await read(previewFile)};
  try{
    await runtime.start();await runtime.installPackage(MOD);await runtime.startWindow({name:'gitlab-empty-setup',layout:{id:'empty-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',children:[{id:'tabs',type:'block',size:{px:42},content:{mod:'tabs'}},{id:'empty-gitlab',type:'block',content:{mod:MOD,props:{view:'merges'}}}]}});await positionWindow(runtime);
    let serial=0;const visible=async query=>until(async()=>{const frame=await runtime.frame('gitlab-empty-'+(++serial)),observation=await runtime.driver.ocr(path.resolve(frame.path),query);return observation.matches.length===1&&observation.matches[0].confidence>=0.6?{observation,node:observation.matches[0]}:null;},'empty GitLab setup '+query);
    const button=await visible('Set up GitLab');runtime.expect(runtime.hc(['ls','--json']).terminals.length===1,'Empty setup has only its original positively owned sentinel and no invented agent');await runtime.driver.clickObservedText(button.observation,button.node);await visible('GitLab connection');
    const configFile=path.join(runtime.env.HERDR_APP_HOME,'mission-control/config.json'),configBefore=await read(configFile),save=await visible('Save connection');await runtime.driver.clickObservedText(save.observation,save.node);await visible('Check this GitLab profile');runtime.expect((await read(configFile))?.toString()===configBefore?.toString(),'Incomplete setup preserves the exact existing or absent configuration');runtime.expect(runtime.hc(['ls','--json']).terminals.length===1,'Incomplete setup cannot create an agent');runtime.expect(runtime.app(['status']).errors.length===0,'Empty setup validation produces no native app error');
  }catch(error){failure=error;}
  finally{if(runtime.directory)try{await runtime.close();}catch(error){failure??=error;}}
  try{const receiptAfter=await read(receiptFile),previewAfter=await read(previewFile);publicReceiptUnchanged=before.receipt===null?receiptAfter===null:before.receipt.equals(receiptAfter);publicPreviewUnchanged=before.preview===null?previewAfter===null:before.preview.equals(previewAfter);assert.equal(publicReceiptUnchanged,true);assert.equal(publicPreviewUnchanged,true);}catch(error){failure??=error;}
  const report={schema:'mission-control-empty-setup-negative-v1',passed:!failure,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup,cleanupError:runtime.closeError?{code:runtime.closeError.code,message:runtime.closeError.message}:null,negativeReceipt:runtime.receipt(false,Object.assign(Error('An unconfigured view is not a successful feature/release gate.'),{code:'EMPTY_SETUP_NOT_RELEASEABLE'})),...(failure?{error:failure.message}:{})};await fs.writeFile('.harness/gitlab-empty-setup.json',JSON.stringify(report,null,2)+'\n');if(failure)throw failure;return {passed:true,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup};
}

/** Temporary wrapped copy exposes state only after an explicit native click. */
export async function diagnoseEmbedded(){
  const runtime=new NativeRuntime();let fixtures,failure;const snapshots=[];
  try{
    await runtime.start({fixtureEnvironment});fixtures=await gitlabFixtures(runtime.directory);fixtures.flags.bodyBytes=4096;await fs.writeFile(CA,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));const actor=await actors(runtime);const config=configuration(runtime,fixtures,{machine:'qa-unused',repo:'/fixture/unused'});delete config.bindings[bindingKey('qa-unused','/fixture/unused')];await fs.mkdir(path.join(runtime.env.HERDR_APP_HOME,'mission-control'),{recursive:true});await fs.writeFile(path.join(runtime.env.HERDR_APP_HOME,'mission-control/config.json'),JSON.stringify(config));
    const requests={};for(let index=0;index<8;index++){const id='diagnostic-'+index,number=42+index,source={kind:'gitlab-mr',connectionId:'work',site:fixtures.work.origin,id:sourceId('work',number),key:'GL-MR-'+number,title:'Owned diagnostic MR',url:fixtures.work.origin+'/group/subgroup/web/-/merge_requests/'+number},request={requestId:id,idempotencyKey:id,originId:'diagnostic-origin-'+index,spaceId:runtime.spaceId,machine:null,repoRoot:runtime.repo,checkoutRoot:runtime.repo,toolKey:['claude','codex','grok'][index%3],source,worktree:true};requests[id]={request,ack:{space:runtime.spaceId,tab:runtime.tabId,terminal:runtime.sentinel},state:'complete',createdAt:Date.now(),updatedAt:Date.now(),leaseUntil:0,owner:'diagnostic',key:JSON.stringify([null,runtime.repo,'source',JSON.stringify([source.kind,source.connectionId,source.site,source.id]),request.toolKey]),folder:runtime.repo};}await fs.writeFile(path.join(runtime.env.HERDR_APP_HOME,'mission-control/launches.json'),JSON.stringify({v:1,revision:1,requests}));
    await runtime.installPackage(MOD);await wrapDiagnostic(runtime);
    await runtime.startWindow({name:'gitlab-embedded-diagnostic',layout:{id:'diagnostic-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',children:[{id:'tabs',type:'block',size:{px:42},content:{mod:'tabs'}},{id:'tracker',type:'stack',active:'issues',children:[{id:'issues',type:'block',content:{mod:MOD,props:{view:'issues'}}},{id:'merges',type:'block',content:{mod:MOD,props:{view:'merges'}}},{id:'embedded-issues',type:'block',content:{mod:MOD,props:{view:'issues',hideHeader:true}}},{id:'embedded-merges',type:'block',content:{mod:MOD,props:{view:'merges',hideHeader:true}}}]}]}});await positionWindow(runtime);
    let index=0;for(const record of Object.values(requests)){const folder=path.join(runtime.directory,'diagnostic-checkout-'+index);run('git',['-C',runtime.repo,'worktree','add','-q','-b','diag-'+index,folder],{env:runtime.env,json:false});const ack=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder,name:record.request.source.key,argv:actor.programs[record.request.toolKey].run})]);record.ack=ack;record.folder=folder;index++;}await fs.writeFile(path.join(runtime.env.HERDR_APP_HOME,'mission-control/launches.json'),JSON.stringify({v:1,revision:2,requests}));runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','pane.focus',JSON.stringify({terminal:runtime.sentinel})]);
    for(const view of ['issues','merges','embedded-issues','embedded-merges']){runtime.app(['do','layout.select',JSON.stringify({stack:'tracker',child:view})]);await delay(4000);const frame=await runtime.frame('gitlab-diagnostic-'+view),observation=await runtime.driver.ocr(path.resolve(frame.path),'Inspect'),matches=observation.matches.filter(n=>n.confidence>=0.6&&n.frame.x>observation.window.width-100&&n.frame.y<120);assert.equal(matches.length,1);await runtime.driver.clickObservedText(observation,matches[0]);const snapshot=await until(async()=>{const value=(await runtime.shared())['gitlab-private-diagnostic'];return value?.embedded===view.startsWith('embedded-')&&value?.role===(view.endsWith('merges')?'merges':'panel')?value:null;},'native diagnostic snapshot');snapshots.push({view,...snapshot});console.log(JSON.stringify({view,...snapshot}));}
  }catch(error){failure=error;}
  finally{await fixtures?.close();if(runtime.directory)try{await runtime.close();}catch(error){failure??=error;}}
  const report={schema:'mission-control-private-embedded-diagnostic-v1',ok:!failure,featureProof:false,modifiedPrivateCopy:true,snapshots,console:runtime.appStderr,requests:fixtures?.observed,cleanup:runtime.cleanup,cleanupError:runtime.closeError?{code:runtime.closeError.code,message:runtime.closeError.message}:null,...(failure?{error:failure.message}:{})};await fs.writeFile('.harness/gitlab-embedded-diagnostic.json',JSON.stringify(report,null,2)+'\n');if(failure)throw failure;return report;
}

/** Full reproduction with private-only inspection; never a release gate. */
export async function diagnoseFull(){
  const runtime=new NativeRuntime();runtime.diagnosticWrapped=true;let failure;
  try{await runtime.start({fixtureEnvironment});await gitlab(runtime);}catch(error){failure=error;}
  finally{if(runtime.directory)try{await runtime.close();}catch(error){failure??=error;}}
  const report={schema:'mission-control-private-full-diagnostic-v1',featureProof:false,modifiedPrivateCopy:true,reproduced:Boolean(failure),error:failure?.message,console:runtime.appStderr,cleanup:runtime.cleanup,cleanupError:runtime.closeError?{code:runtime.closeError.code,message:runtime.closeError.message}:null,diagnosticReceipt:runtime.receipt(false,Object.assign(Error(failure?.message||'Private diagnostic copy cannot release a package.'),{code:'DIAGNOSTIC_NOT_RELEASEABLE'}))};await fs.writeFile('.harness/gitlab-full-diagnostic.json',JSON.stringify(report,null,2)+'\n');return {featureProof:false,reproduced:report.reproduced,error:report.error,cleanup:report.cleanup};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2],check=mode==='fixture-check'?checkFixtures:mode==='empty-setup-check'?checkEmptySetup:mode==='embedded-diagnostic'?diagnoseEmbedded:mode==='full-diagnostic'?diagnoseFull:null;if(!check)throw Error('Use the reviewed native harness for the full mounted gate, fixture-check for the core-free preflight, or empty-setup-check for the private negative setup proof.');check().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
}
