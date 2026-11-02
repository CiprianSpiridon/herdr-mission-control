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
import {prDetailCursor,prActionAvailability} from '../../src/mods/mission-control-github/pull-model.js';

const MOD='mission-control-github',ISSUES='mission-control-github-ui-v1',PULLS='mission-control-github-prs-ui-v1';
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const CA=path.resolve('.harness/github-fixture-cas.pem'),HEAD='a'.repeat(40),BASE='b'.repeat(40);
// The harness validates this record before private startup. Import is pure.
export const fixtureEnvironment={NODE_EXTRA_CA_CERTS:CA,QA_GITHUB_WORK:'owned-github-work',QA_GITHUB_PERSONAL:'owned-github-personal'};

export async function githubFixtures(directory){
  const sites=[],pending=new Set(),flags={denyWork:false,denyPersonal:false,hold:null,large:false,changedHead:null},observed=[];
  async function site(profile,owner,repo){
    let service;
    const repository=(full=owner+'/'+repo)=>({id:full===owner+'/'+repo?900:901,full_name:full,name:full.split('/')[1],owner:{login:full.split('/')[0]},html_url:service.origin+'/'+full,has_issues:true});
    const issue=(full,number,state='open',labels=[])=>({id:10000+number,node_id:'I_'+number,number,title:({142:'Fix login redirect',156:'Improve account settings',168:'Restore keyboard navigation'})[number],body:'Owned GitHub issue task. Keep this captured repository.',state,labels:labels.map(name=>({name})),updated_at:'2026-10-30T10:00:00Z',url:service.origin+'/api/v3/repos/'+full+'/issues/'+number,repository_url:service.origin+'/api/v3/repos/'+full,html_url:service.origin+'/'+full+'/issues/'+number});
    const pull=(full,number)=>({id:20000+number,node_id:'PR_'+full.replace('/','_')+'_'+number,number,title:(profile==='personal'?'Server: ':'')+(({42:'Review reconnect handling',43:'Address redirect comments',44:'Repair failing checks',45:'Inspect contributor fork',46:'Unavailable source branch',47:'Partial review threads',48:'Deleted author patch',49:'Restricted review threads',50:'Closed patch',51:'Merged patch',52:'Draft patch'})[number]||'Scale test PR '+number),body:'Owned PR description. Related task: https://qa.atlassian.invalid/browse/WEB-7',state:[50,51].includes(number)?'closed':'open',merged_at:number===51?'2026-10-29T10:00:00Z':null,draft:number===52,user:number===48?null:{login:profile==='work'?'alice':'bob',html_url:service.origin+'/'+(profile==='work'?'alice':'bob')},updated_at:'2026-10-30T10:00:00Z',url:service.origin+'/api/v3/repos/'+full+'/pulls/'+number,html_url:service.origin+'/'+full+'/pull/'+number,head:{ref:'fix/pr-'+number,sha:flags.changedHead?.profile===profile&&flags.changedHead.number===number?'c'.repeat(40):HEAD,repo:repository(number===45?'contributor/fork':full)},base:{ref:'main',sha:BASE,repo:repository(full)}});
    const graph=raw=>{
      const full=raw.base.repo.full_name,n=raw.number,threads={totalCount:n===44?0:2,nodes:n===44?[]:[{id:'T_'+n+'_1',isResolved:false,isOutdated:false},{id:'T_'+n+'_2',isResolved:false,isOutdated:false}],pageInfo:{hasNextPage:n===47}};
      const node={__typename:'PullRequest',id:raw.node_id,number:n,url:raw.html_url,state:raw.merged_at?'MERGED':raw.state.toUpperCase(),isDraft:raw.draft,updatedAt:raw.updated_at,repository:{nameWithOwner:full,url:service.origin+'/'+full},headRefName:raw.head.ref,headRefOid:raw.head.sha,baseRefName:'main',baseRefOid:BASE,headRepository:{nameWithOwner:raw.head.repo.full_name,url:raw.head.repo.html_url},headRef:n===46?null:{name:raw.head.ref,target:{oid:raw.head.sha}},baseRef:{name:'main',target:{oid:BASE}},reviewDecision:n===43?'CHANGES_REQUESTED':n===44?'APPROVED':null,reviewThreads:n===49?null:threads,statusCheckRollup:{commit:{oid:raw.head.sha},state:'FAILURE',contexts:{totalCount:1,pageInfo:{hasNextPage:false},nodes:[{__typename:'CheckRun',id:'C_'+n,status:'COMPLETED',conclusion:'FAILURE',checkSuite:{commit:{oid:raw.head.sha}}}]}},closingIssuesReferences:{nodes:[{id:'I_142',number:142,url:service.origin+'/'+full+'/issues/142',repository:{nameWithOwner:full}}],pageInfo:{hasNextPage:false}}};
      return {data:{node},...(n===49?{errors:[{type:'FORBIDDEN',path:['node','reviewThreads'],message:'Synthetic private text must not escape.'}]}:{})};
    };
    service=await createFixtureService(path.join(directory,profile),{handler:async request=>{
      const url=new URL(request.url,'https://fixture.invalid'),match=url.pathname.match(/^\/api\/v3\/repos\/([^/]+\/[^/]+)(?:\/(issues|pulls)(?:\/([1-9][0-9]*))?)?$/),expected='Bearer '+(profile==='work'?'owned-github-work':'owned-github-personal'),authorized=request.headers.authorization===expected;
      const observation={profile,method:request.method,path:url.pathname,authorized,queryName:request.body?.query?.match(/query\s+(\w+)/)?.[1]||null};observed.push(observation);
      if(url.pathname.startsWith('/api/')&&(!authorized||flags[profile==='work'?'denyWork':'denyPersonal']))return {status:authorized?403:401,body:{error:'Synthetic private text must not escape.'}};
      if(match){
        const full=match[1];if(![owner+'/'+repo,'other/rebound'].includes(full))return {status:404,body:{error:'No owned repository'}};
        if(!match[2])return {body:repository(full)};
        if(match[2]==='issues')return {body:[issue(full,142,'open',['todo']),issue(full,156,'open',['doing']),issue(full,168,'closed',['done'])]};
        if(!match[3]){
          const perPage=Number(url.searchParams.get('per_page')||30),page=Number(url.searchParams.get('page')||1),numbers=Array.from({length:flags.large?120:11},(_,index)=>index+(flags.large?1000:42));
          assert.equal(perPage,50,'The production adapter must request actual 50-item pages');assert.ok(Number.isSafeInteger(page)&&page>0);const selected=numbers.slice((page-1)*perPage,page*perPage);Object.assign(observation,{large:flags.large,page,perPage,returned:selected.length});
          const next=new URL(service.origin+request.url);next.searchParams.set('page',String(page+1));return {body:selected.map(number=>pull(full,number)),headers:page*perPage<numbers.length?{link:'<'+next.href+'>; rel="next"'}:{}};
        }
        const selected=pull(full,Number(match[3]));
        if(flags.hold?.profile===profile&&flags.hold.number===selected.number){const hold=flags.hold;hold.entered=true;pending.add(hold);try{await hold.promise;}finally{pending.delete(hold);}}
        return {body:pull(full,Number(match[3]))};
      }
      if(url.pathname==='/api/graphql'&&request.method==='POST'){
        if(!request.body?.query?.includes('MissionControlPullDetail')||/\bmutation\b/.test(request.body.query))return {status:400,body:{error:'Only the owned read query is allowed'}};
        const selected=request.body.variables.id.match(/^PR_([^_]+)_([^_]+)_([1-9][0-9]*)$/);return selected?{body:graph(pull(selected[1]+'/'+selected[2],Number(selected[3])))}:{status:404,body:{error:'Unknown fixture node'}};
      }
      // Public source/author links are served by the same task-owned endpoint.
      if(/^\/[^/]+(?:\/[^/]+\/(?:pull|issues)\/[1-9][0-9]*)?$/.test(url.pathname))return {body:{fixture:profile,path:url.pathname}};
      return {status:404,body:{error:'No fixture route'}};
    }});sites.push(service);return service;
  }
  try{const work=await site('work','acme','web'),personal=await site('personal','personal','server');return {work,personal,flags,observed,sites,
    hold(profile,number){if(flags.hold)throw Error('A fixture detail is already held');let release;const hold={profile,number,entered:false,promise:new Promise(resolve=>release=resolve),release:()=>{release();if(flags.hold===hold)flags.hold=null;}};flags.hold=hold;return hold;},
    async close(){flags.hold?.release();for(const hold of pending)hold.release();for(const service of [...sites].reverse())await service.close();}
  };}catch(error){for(const service of sites.reverse())await service.close();throw error;}
}

function configuration(runtime,fixtures,remote){
  const config=newConfig(),local={machine:null,repoRoot:runtime.repo,github:{connectionId:'work',owner:'acme',repo:'web',status:{labels:{todo:['todo'],inProgress:['doing'],done:['done']}}}},server={machine:remote.machine,repoRoot:remote.repo,github:{connectionId:'personal',owner:'personal',repo:'server'}};
  config.connections={work:{id:'work',kind:'github',site:fixtures.work.origin,apiBase:fixtures.work.origin+'/api/v3',credentialEnv:'QA_GITHUB_WORK'},personal:{id:'personal',kind:'github',site:fixtures.personal.origin,apiBase:fixtures.personal.origin+'/api/v3',credentialEnv:'QA_GITHUB_PERSONAL'}};
  config.bindings={[bindingKey(null,runtime.repo)]:local,[bindingKey(server.machine,server.repoRoot)]:server};config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree:true,tools:{}};return config;
}

async function actors(runtime){
  const directory=path.join(runtime.directory,'actor-input');await fs.mkdir(directory);const programs={};
  for(const key of ['claude','codex','grok']){
    const file=path.join(runtime.directory,'qa-'+key);
    await fs.writeFile(file,`#!/usr/bin/env python3
import os,sys,time,json,select,tty
if '--help' in sys.argv: print('QA ${key}\\nUsage: ${key} [OPTIONS] [PROMPT]\\n --model <MODEL>');sys.exit(0)
if '--version' in sys.argv: print('Native GitHub fixture 1.0');sys.exit(0)
directory=${JSON.stringify(directory)}
record={'tool':'${key}','pid':os.getpid(),'cwd':os.getcwd(),'argv':sys.argv[1:],'received':''}
file=os.path.join(directory,str(os.getpid())+'.json')
def save():
 temporary=file+'.next'
 with open(temporary,'w') as output: json.dump(record,output)
 os.replace(temporary,file)
if sys.stdin.isatty(): tty.setraw(sys.stdin.fileno())
save()
print('Disposable GitHub native actor; no provider call.',flush=True)
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
  const source=path.join(runtime.directory,'github-position.swift'),binary=path.join(runtime.directory,'github-position');
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
  await until(async()=>{const result=run(binary,[String(runtime.owner.pid)]);if(result.retry)return false;const frame=await runtime.driver.bindWindow(result.windowId);return Math.abs(frame.width-1280)<2&&Math.abs(frame.height-760)<2&&Math.abs(frame.x-300)<2&&Math.abs(frame.y-350)<2;},'owned GitHub window position and native input bounds');
}

export default async function github(runtime){
  const home=runtime.env.HERDR_APP_HOME,configFile=path.join(home,'mission-control/config.json'),server=new NativeRuntime();let fixtures,connected=false;
  try{
    fixtures=await githubFixtures(runtime.directory);await fs.writeFile(CA,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    const actor=await actors(runtime);await server.start();
    const via=path.join(runtime.directory,'github-via.py'),selectors=Object.fromEntries(Object.entries(server.env).filter(([key])=>['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'].includes(key)));
    await fs.writeFile(via,`#!/usr/bin/env python3\nimport os,sys,json\ne=os.environ.copy();e.update(json.loads(${JSON.stringify(JSON.stringify(selectors))}))\nos.execvpe('/bin/sh',['sh','-c',sys.argv[-1]],e)\n`);await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name','qa-server','--session',server.env.HC_SESSION,'--json']);connected=true;
    const config=configuration(runtime,fixtures,{machine:'qa-server',repo:server.repo});await fs.mkdir(path.dirname(configFile),{recursive:true});await fs.writeFile(configFile,JSON.stringify(config));
    await runtime.installPackage(MOD);const workBinding=config.bindings[bindingKey(null,runtime.repo)],personalBinding=config.bindings[bindingKey('qa-server',server.repo)];
    for(const binding of [workBinding,personalBinding]){const reply=await helper(home,runtime.env,{v:1,operation:'issues',connection:config.connections[binding.github.connectionId],binding});runtime.expect(reply.ok&&reply.snapshot.data.length===3,'Copied standalone helper reads all owned '+binding.github.connectionId+' issues without Jira');}
    const linked=path.join(runtime.directory,'linked-checkout');run('git',['-C',runtime.repo,'worktree','add','-q','-b','qa-linked',linked],{env:runtime.env,json:false});await fs.writeFile(path.join(linked,'linked.md'),'Captured linked checkout HEAD\n');run('git',['-C',linked,'add','linked.md'],{env:runtime.env,json:false});run('git',['-C',linked,'commit','-qm','Advance linked fixture'],{env:runtime.env,json:false});const linkedHead=run('git',['-C',linked,'rev-parse','HEAD'],{env:runtime.env,json:false});
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[300,350,1280,760]}));
    const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
    await runtime.startWindow({name:'github-native',layout:{id:'qa-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',children:[block('tabs','tabs',42),{id:'workspace',type:'row',children:[{id:'tracker',type:'stack',size:{weight:3},active:'issues',children:[block('issues',MOD,null,{view:'issues'}),block('pulls',MOD,null,{view:'pulls'})]},{id:'terminal',type:'block',size:{px:280},content:{tab:'active'}}]},block('status','workspace-status',26)]}});
    await positionWindow(runtime);const remote=await until(()=>runtime.app(['ls']).spaces.find(s=>s.machine==='qa-server'),'GitHub remote fixture space adoption');runtime.app(['do','space.rename',JSON.stringify({id:remote.id,name:'server-repo'})]);runtime.app(['do','space.rename',JSON.stringify({id:runtime.spaceId,name:'client-portal'})]);
    const linkedTab=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:linked,argv:actor.programs.claude.run})]);
    const focusLocal=()=>{runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','pane.focus',JSON.stringify({terminal:linkedTab.terminal})]);};focusLocal();
    let serial=0,role='issues';const observe=async(query='')=>{if(++serial>400)throw Error('Native GitHub observation budget exhausted');const frame=await runtime.frame('github-observe-'+serial),observation=await runtime.driver.ocr(path.resolve(frame.path),query);if(observation.lines.some(n=>/\binterrupted\b|render.*error|could not complete this action/i.test(n.text)))throw Error('Native GitHub render/action error banner: '+observation.lines.map(n=>n.text).join(' | '));return observation;};
    const inBoard=(n,o)=>n.frame.x<o.window.width-280&&n.frame.y>80&&n.frame.y<o.window.height-35;
    const text=(query,predicate=inBoard)=>until(async()=>{const o=await observe(query),matches=o.matches.filter(n=>n.confidence>=0.6&&predicate(n,o));return matches.length===1?{observation:o,node:matches[0]}:null;},'visible unique GitHub text '+query,45000);
    const click=async(query,predicate)=>{const {observation,node}=await text(query,predicate);await runtime.driver.clickObservedText(observation,node);};
    const has=async query=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.6&&inBoard(n,o));};
    // One screen read can miss text that is there; positive checks re-read briefly before failing.
    const eventually=check=>until(async()=>await check()?true:null,'visible GitHub text',10000).catch(()=>false);
    const state=async()=>(await runtime.shared())[role==='pulls'?PULLS:ISSUES];
    // A click that lands while the field is still taking focus types nowhere; retry the whole entry, never a partial one.
    const search=async value=>{for(let attempt=0;;attempt++){try{return await searchOnce(value);}catch(error){if(attempt>=2||!/native GitHub query/.test(error.message))throw error;}}};
    const searchOnce=async value=>{
      focusLocal();let prior=null,target;
      // A completed tab can still be applying focus/launch status. Wait for
      // the real search control to stop moving before typing into that point.
      await until(async()=>{const old=(await state())?.query||'Search '+(role==='pulls'?'pull requests':'issues'),next=await text(old,(n,o)=>inBoard(n,o)&&n.frame.y<155&&n.frame.x>150),box=JSON.stringify(next.node.frame);if(box===prior){target=next;return true;}prior=box;return false;},'stable native GitHub search control');
      const {observation,node}=target;await runtime.driver.clickObservedText(observation,node);await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');if(value){await runtime.driver.bridge('type',value);runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:'GitHub search',characters:value.length,observation:observation.source});}await until(async()=>((await state())?.query??'')===value,'native GitHub query '+value,10000);
    };

    const toolbar=async name=>{const query=(await state())?.query||'Search '+(role==='pulls'?'pull requests':'issues'),{observation,node}=await text(query,(n,o)=>inBoard(n,o)&&n.frame.y<155&&n.frame.x>150),width=observation.window.width-280;await runtime.driver.click({x:width-(name==='refresh'?73:42),y:node.frame.y+node.frame.height/2-14,width:28,height:28},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'GitHub '+name,observation:observation.source});};
    const selectView=async view=>{runtime.app(['do','layout.select',JSON.stringify({stack:'tracker',child:view})]);role=view;await text(view==='pulls'?'Pull':'GitHub',(n,o)=>n.frame.x<o.window.width-280&&n.frame.y>42&&n.frame.y<80);};
    const journal=async()=>{try{return Object.values(JSON.parse(await fs.readFile(path.join(home,'mission-control/launches.json'),'utf8')).requests);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
    const completed=async source=>until(async()=>{const rows=await journal();return rows.find(r=>r.state==='complete'&&r.request.source.id===source);},'actual acknowledged native launch '+source);
    const received=async(record,action)=>until(async()=>{const raw=(await actor.read()).find(row=>row.tool===record.request.toolKey&&row.cwd===record.folder);return raw&&(raw.argv.join('\n')+'\n'+raw.received).includes('Mission Control action: '+action)?raw:null;},'task received by disposable '+record.request.toolKey+' actor');
    const issueIcon=async(key,index)=>{const {observation,node}=await text(key,(n,o)=>inBoard(n,o)&&n.frame.y>170),width=observation.window.width-280,padding=width<768?10:14,columnWidth=width<768?Math.min(460,width-2*padding):Math.min(360,(width-2*padding-24)/3),left=node.frame.x-11;await runtime.driver.click({x:left+columnWidth-10-106+index*27,y:node.frame.y-1+14+7+36+7+1,width:25,height:25},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'GitHub issue '+key+' agent '+index,observation:observation.source});};
    const prIcon=async index=>{const {observation,node}=await text('Address comments',(n,o)=>inBoard(n,o)&&n.frame.y>170),right=observation.window.width-280-14;await runtime.driver.click({x:right-11-110+index*28,y:node.frame.y+node.frame.height/2+20,width:26,height:26},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Selected PR agent '+index,observation:observation.source});};
    const closeOverlay=async()=>{await runtime.driver.press('escape');await until(()=>!runtime.app(['status']).overlays.length,'closed GitHub own-mod dialog');};
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
      if(!target)throw Error('GitHub setup field is unavailable: '+title);const {observation,node}=target;
      await runtime.driver.click({x:right?observation.window.width/2+24:node.frame.x+20,y:node.frame.y+node.frame.height+9,width:150,height:20},{expectedSize:observation.window});await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await runtime.driver.bridge('type',value);runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:title,characters:value.length,observation:observation.source});
    };

    let o;console.log('GitHub native: setup, shortcuts and source links');await text('GH-142');
    await toolbar('settings');await text('GitHub connection',(n,o)=>n.frame.x>o.window.width/2-340&&n.frame.x<o.window.width/2+340&&n.frame.y>=0&&n.frame.y<120);await click('New profile',(n,o)=>n.text==='New profile'&&n.frame.x>o.window.width/2-80&&n.frame.x<o.window.width/2+80);await field('Profile ID','github-native');await field('GitHub site',fixtures.work.origin);await field('Token environment variable','QA_GITHUB_WORK');await field('Repository owner','acme');await field('Repository owner','web',{right:true});await click('Labels');await field('To do','todo');await field('In progress','doing');await field('Done','done');await click('Save connection',(n,o)=>n.frame.y>50);await until(()=>!runtime.app(['status']).overlays.length,'native GitHub setup probe and save');
    const saved=JSON.parse(await fs.readFile(configFile,'utf8'));runtime.expect(saved.bindings[bindingKey(null,runtime.repo)].github.connectionId==='github-native'&&saved.connections['github-native'].credentialEnv==='QA_GITHUB_WORK'&&saved.connections['github-native'].apiBase===fixtures.work.origin+'/api/v3','Actual standalone setup probes its selected site and saves only environment references');runtime.expect(saved.bindings[bindingKey(null,runtime.repo)].github.status.labels.inProgress.join(',')==='doing','Mounted label-mapping form persists the explicit In progress source mapping');await text('GH-142');
    o=await observe();await runtime.driver.click({x:o.window.width-280-40,y:47,width:28,height:28},{expectedSize:o.window});Object.assign(runtime.driver.actions.at(-1),{control:'GitHub agent shortcuts',observation:o.source});await text('Agent shortcuts',(n,o)=>n.frame.y>20);const grok=await text('QA grok',(n,o)=>n.frame.x>o.window.width/2-280&&n.frame.x<o.window.width/2+280),left=(grok.observation.window.width-560)/2;await runtime.driver.click({x:left+560-128,y:grok.node.frame.y+grok.node.frame.height/2-14,width:28,height:28},{expectedSize:grok.observation.window});await click('Save shortcuts');await until(async()=>JSON.stringify(JSON.parse(await fs.readFile(configFile,'utf8')).preferences.launch.pins)==='["claude","codex"]','native GitHub pin settings save');runtime.expect(true,'Actual own-mod shortcut settings change the pinned tools');await closeOverlay();await text('GH-142');await writeConfig(value=>{value.connections=config.connections;value.bindings=config.bindings;value.preferences=config.preferences;});await toolbar('refresh');await text('GH-142');
    const linkPath='/acme/web/issues/168';await click('GH-168');await sourceOpened(fixtures.work.origin+linkPath);runtime.expect(true,'Actual native issue-key click opens its captured task-owned source URL');
    console.log('GitHub native: 120-PR pagination and scroll');
    await selectView('pulls');focusLocal();await search('');await text('Review reconnect handling',(n,o)=>inBoard(n,o)&&n.frame.y>170);fixtures.flags.large=true;const paginationStart=fixtures.observed.length;await toolbar('refresh');await text('60 / 120 loaded');runtime.expect(await has('Scale test PR 1000')&&!(await has('Scale test PR 1119')),'Initial native PR list keeps 60 records while later rows remain offscreen');await click('Show more');await text('120 / 120 loaded');
    let last;for(let attempt=0;attempt<24;attempt++){const observation=await observe('Scale test PR 1119'),matches=observation.matches.filter(n=>n.confidence>=0.6&&inBoard(n,observation));if(matches.length===1){last={observation,node:matches[0]};break;}for(let step=0;step<6;step++)await runtime.driver.scroll({x:observation.window.width-320,y:observation.window.height/2,width:8,height:8},-2000,{expectedSize:observation.window});}assert.ok(last,'A genuine offscreen PR must become visible through native list scrolling');
    const offscreenPath='/acme/web/pull/1119';await runtime.driver.clickObservedText(last.observation,last.node);await sourceOpened(fixtures.work.origin+offscreenPath);const pages=fixtures.observed.slice(paginationStart).filter(r=>r.large&&r.profile==='work'&&r.path==='/api/v3/repos/acme/web/pulls');runtime.expect([1,2,3].every((page,index)=>pages.some(r=>r.page===page&&r.perPage===50&&r.returned===[50,50,20][index])),'Native 120-PR fixture uses real same-origin Link pages of 50/50/20');runtime.expect(true,'Native Show more and scrolling expose an interactive offscreen retained PR without a render-error banner');
    fixtures.flags.large=false;await toolbar('refresh');await search('Review reconnect handling');await text('Review reconnect handling',(n,o)=>inBoard(n,o)&&n.frame.y>170);await search('');await selectView('issues');focusLocal();await text('GH-142');
    console.log('GitHub native: issues and PR actions');
    await text('GH-142');await text('GH-156');await text('GH-168');runtime.expect(await has('To do')&&await has('In progress')&&await has('Done'),'Mounted issue cards show all mapped source workflow groups');o=await observe('GitHub');runtime.expect(o.matches.filter(n=>n.confidence>=0.6&&n.frame.x<o.window.width-280&&n.frame.y>42&&n.frame.y<o.window.height-26).length===1,'Standalone issue view has one provider heading');runtime.expect(!o.lines.some(n=>['QA claude','QA codex','QA grok','Actions'].includes(n.text)),'Mounted cards display tool icons without repeated tool names or Actions labels');
    await click('Done',(n,o)=>inBoard(n,o)&&n.frame.y>130&&n.frame.y<170);await until(async()=>(await state())?.status==='done','native GitHub Done filter');runtime.expect(await has('GH-168')&&!(await has('GH-142')),'Mounted issue filter removes other workflow groups');await click('All',(n,o)=>inBoard(n,o)&&n.frame.y>130&&n.frame.y<170);await until(async()=>(await state())?.status==='all','native GitHub All filter');await search('settings');runtime.expect(await has('GH-156')&&!(await has('GH-142')),'Native issue text search filters compact cards');await search('');
    await issueIcon('GH-142',0);const issue=await completed('10142');runtime.expect(issue.request.checkoutRoot===linked&&path.basename(issue.folder)==='client-portal-GH-142','One-click issue start retains linked execution checkout and workspace-plus-key naming');runtime.expect(run('git',['-C',issue.folder,'rev-parse','HEAD'],{env:runtime.env,json:false})===linkedHead,'Actual new issue worktree starts at the selected linked checkout HEAD');const issueCount=runtime.hc(['ls','--json']).terminals.length;await issueIcon('GH-142',0);await delay(400);runtime.expect(runtime.hc(['ls','--json']).terminals.length===issueCount,'Actual repeated issue click creates no duplicate terminal');
    await selectView('pulls');focusLocal();await text('Review reconnect handling');runtime.expect(await eventually(()=>has('@alice')),'Dedicated mounted PR cards show the actual author');await search('Review reconnect handling');await click('Details');await text('Checks failed');runtime.expect(await eventually(()=>has('2 unresolved')),'Mounted PR details show independent unresolved threads');runtime.expect(await eventually(()=>has('Review unavailable')),'Null review decision is visible without inventing approval');runtime.expect(await eventually(async()=>await has('#142')&&!(await has('I_142'))),'Linked GitHub issue shows its human number instead of an opaque node ID');
    await prIcon(0);const review=await completed('acme/web#42'),reviewInput=await received(review,'Review pull request');runtime.expect(review.request.checkoutRoot===linked&&review.request.source.key==='GH-PR-42','PR Review captures the linked checkout and canonical remote identity separately from its label');runtime.expect(reviewInput.received.includes('Goal: Review the changes')||reviewInput.argv.some(v=>v.includes('Goal: Review the changes')),'Actual universal task reaches a tool without advanced instruction flags');
    await click('Fix checks',(n,o)=>inBoard(n,o)&&n.frame.y>170);const countBefore=(await actor.read()).length,inputBefore=(await actor.read()).find(row=>row.pid===reviewInput.pid).received;await text('Open agent');await prIcon(0);await text('No new task was sent.');await delay(400);runtime.expect((await actor.read()).length===countBefore&&(await actor.read()).find(row=>row.pid===reviewInput.pid).received===inputBefore,'A different selected action on existing PR/tool work only focuses it and sends no new task');
    for(const [query,action,index,id,prefix]of [['Address redirect comments','Address comments',1,'acme/web#43','Address review comments'],['Repair failing checks','Fix checks',2,'acme/web#44','Fix failing checks']]){focusLocal();await search(query);await click(action,(n,o)=>inBoard(n,o)&&n.frame.y>170);await prIcon(index);const record=await completed(id);await received(record,prefix);runtime.expect(record.request.checkoutRoot===linked&&record.request.repoRoot===runtime.repo,'Mounted '+prefix+' freezes its own linked target and reaches its selected installed tool');}
    await search('Inspect contributor fork');await click('Details');await text('Checks failed');await click('Fix checks',(n,o)=>inBoard(n,o)&&n.frame.y>170);await prIcon(0);const fork=await completed('acme/web#45');await received(fork,'Review pull request');runtime.expect(fork.request.repoRoot===runtime.repo,'A fork remains reviewable while disabled Fix checks cannot change the selected review action');
    await search('Unavailable source branch');await click('Details');await text('Checks failed');const beforeUnavailable=(await actor.read()).length;await prIcon(0);await delay(400);runtime.expect((await actor.read()).length===beforeUnavailable&&!(await journal()).some(r=>r.request.source.id==='acme/web#46'),'Unavailable refs cannot create a new native agent');
    await search('Partial review threads');await click('Details');await text('Threads unavailable');await click('Fix checks',(n,o)=>inBoard(n,o)&&n.frame.y>170);await prIcon(2);await received(await completed('acme/web#47'),'Fix failing checks');runtime.expect(true,'Partial discussions remain independent of complete failed checks in the mounted view');
    await search('Deleted author patch');await text('Deleted account');runtime.expect(!(await has('@alice')),'Deleted authors use an explicit fallback in the actual PR card');await search('');
    await click('All spaces',(n,o)=>inBoard(n,o)&&n.frame.y<140);await until(async()=>(await state())?.all===true,'mounted PR All-spaces scope');await search('Server: Review reconnect handling');await text('@bob');
    const held=fixtures.hold('personal',42);focusLocal();await prIcon(1);await until(()=>held.entered,'remote clicked PR detail actually pending');runtime.app(['do','space.select',JSON.stringify({id:remote.id})]);focusLocal();await click('This space',(n,o)=>inBoard(n,o)&&n.frame.y<140);await until(async()=>(await state())?.all===false,'held remote PR origin leaves All-spaces visibility');await text('No matching pull requests');held.release();const remoteRecord=await completed('personal/server#42');await received(remoteRecord,'Review pull request');
    const remoteRaw=server.hc(['get',localTerminalAddress(remoteRecord.ack.terminal,'qa-server'),'--json']);runtime.expect(remoteRecord.request.spaceId===remote.id&&remoteRecord.request.machine==='qa-server'&&remoteRecord.request.repoRoot===server.repo&&remoteRecord.request.checkoutRoot===server.repo&&remoteRecord.request.source.connectionId==='personal'&&remoteRaw.cwd===remoteRecord.folder,'Held PR launch survives removal of its visible source and keeps B’s original machine/repository/account on the separate actual core');
    await search('Review reconnect handling');await click('This space',(n,o)=>inBoard(n,o)&&n.frame.y<140);await until(async()=>(await state())?.all===false,'mounted PR current-space scope');focusLocal();await search('Repair failing checks');runtime.app(['do','tab.close',JSON.stringify({id:(await completed('acme/web#44')).ack.tab,confirmed:true})]);await text('Resume from history');const beforeClosed=(await actor.read()).length;await prIcon(2);await text('exact session from history');runtime.expect((await actor.read()).length===beforeClosed,'Closed PR slots report exact-session history without creating duplicate work');
    await search('Review reconnect handling');const preserved=await fs.readFile(path.join(review.folder,'README.md'),'utf8'),oldCount=runtime.hc(['ls','--json']).terminals.length;await writeConfig(value=>{value.bindings[bindingKey(null,runtime.repo)].github={connectionId:'work',owner:'other',repo:'rebound'};});await toolbar('refresh');await text('other/rebound');await prIcon(0);await text('exists');runtime.expect(runtime.hc(['ls','--json']).terminals.length===oldCount&&await fs.readFile(path.join(review.folder,'README.md'),'utf8')===preserved,'Same-number PR after remote rebind neither focuses old PR nor adopts its occupied default worktree');
    await writeConfig(value=>{value.bindings=config.bindings;});await toolbar('refresh');await text('acme/web');await prIcon(3);await text('New agent',(n,o)=>n.frame.x>o.window.width/2-300&&n.frame.x<o.window.width/2+300&&n.frame.y>40&&n.frame.y<180);runtime.expect(runtime.app(['status']).overlays.includes(MOD),'PR options opens the standalone mod’s own agent/worktree dialog');await closeOverlay();
    // After the rebind round trip, load a fresh same-scope snapshot first: only that may be kept as cached on a failure.
    await search('');await selectView('issues');focusLocal();await text('GH-142');await toolbar('refresh');await text('just now',(n,o)=>n.frame.y>o.window.height-80);await text('GH-142');fixtures.flags.denyWork=true;await toolbar('refresh');await text('cannot read');runtime.expect(await has('GH-142')&&await has('Cached'),'Same-scope provider failure retains real issue cards with an explicit cached label');fixtures.flags.denyWork=false;
    await writeConfig(value=>{value.connections.missing={...value.connections.work,id:'missing',credentialEnv:'QA_GITHUB_NEVER_CONFIGURED'};value.bindings[bindingKey(null,runtime.repo)].github.connectionId='missing';});await toolbar('refresh');await text('credentials are unavailable');runtime.expect(!(await has('GH-142')),'Missing credential capability after an account change clears previous-account cards');await writeConfig(value=>{value.connections=config.connections;value.bindings=config.bindings;});await toolbar('refresh');await text('GH-142');
    await selectView('pulls');focusLocal();await toolbar('refresh');await search('Review reconnect handling');await text('Open agent');runtime.expect(runtime.app(['status']).errors.length===0,'No native errors across mounted issues, PRs and own-mod dialogs');runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(n=>n.startsWith('mission-control-')).join(',')===MOD,'Only this standalone custom mod is installed; Jira is absent');runtime.expect(fixtures.observed.filter(r=>r.path.startsWith('/api/')&&r.method==='POST').every(r=>r.queryName==='MissionControlPullDetail'),'Owned HTTP evidence contains no provider mutation');
    if(await has('Hide details'))await click('Hide details');await click('Details');await text('Checks failed');await click('Hide details');await search('');await text('Review reconnect handling',(n,o)=>inBoard(n,o)&&n.frame.y>170);
    // The published preview shows a healthy list: refresh until nothing reads as failed or cached.
    let healthy=false;
    for(let attempt=0;attempt<4&&!healthy;attempt++){await toolbar('refresh');healthy=await until(async()=>!(await has('could not be reached'))&&!(await has('Cached'))&&await has('Review reconnect handling')?true:null,'freshly loaded pull requests',25000).catch(()=>false);}
    runtime.expect(healthy,'The preview shows a freshly loaded pull-request list without an error banner or cached marker');
    const frame=await runtime.frame('github-preview');await fs.copyFile(path.resolve(frame.path),path.resolve(MOD,'preview.png'));
  }catch(error){
    const directory=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'github-fixture-requests.json'),JSON.stringify(fixtures?.observed||[],null,2));await fs.writeFile(path.join(directory,'github-native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));try{await fs.writeFile(path.join(directory,'github-failure-status.json'),JSON.stringify(runtime.app(['status']),null,2));await runtime.frame('github-failure');}catch{}throw error;
  }finally{await fixtures?.close();if(connected)runtime.hc(['machine','rm','qa-server','--json']);if(server.directory)await server.close();}
}

/** Safe adapter/actor preflight. This never constructs NativeRuntime or opens a window/core. */
export async function checkFixtures(){
  const directory=await fs.mkdtemp('/private/tmp/mcqa-'),home=path.join(directory,'app');let fixtures;
  try{
    // Import this actual module in a fresh process with authored sentinel
    // settings. The child reports only booleans/keys, never environment values.
    const ordinary=['PATH','LANG','LC_ALL','LC_CTYPE','TZ','TERM','NO_COLOR'],importEnv=Object.fromEntries(ordinary.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
    Object.assign(importEnv,{HOME:directory+'/sentinel-home',USERPROFILE:directory+'/sentinel-home',XDG_RUNTIME_DIR:directory+'/sentinel-runtime',HC_SESSION:'sentinel-live-core',HC_SOCKET:directory+'/sentinel-core.sock',HERDR_APP_HOME:directory+'/sentinel-app',HERDR_SOCKET:directory+'/sentinel-app.sock',CODEX_HOME:directory+'/sentinel-codex',CLAUDE_CONFIG_DIR:directory+'/sentinel-claude',GROK_CONFIG_DIR:directory+'/sentinel-grok',GH_TOKEN:'sentinel-ambient-token',ANTHROPIC_API_KEY:'sentinel-ambient-token',QA_GITHUB_WORK:'sentinel-ambient-token',QA_UNSELECTED:'sentinel-ambient-token'});
    const handoff=`import assert from 'node:assert/strict';import {importNativeScenario,isolatedEnvironment} from ${JSON.stringify(new URL('../../scripts/native-harness.mjs',import.meta.url).href)};const before={...process.env};const loaded=await importNativeScenario(${JSON.stringify(fileURLToPath(import.meta.url))});assert.deepEqual({...process.env},before);const env=isolatedEnvironment('/private/tmp/mcqa-preflight','a'.repeat(24),process.env,loaded.fixtureEnvironment);assert.equal(env.HOME,'/private/tmp/mcqa-preflight/h');assert.equal(env.HC_SESSION,'mcqa-'+'a'.repeat(24));assert.equal(env.HERDR_APP_HOME,'/private/tmp/mcqa-preflight/app');assert.equal(env.QA_GITHUB_WORK,'owned-github-work');assert.equal(env.QA_GITHUB_PERSONAL,'owned-github-personal');assert.equal(env.NODE_EXTRA_CA_CERTS,${JSON.stringify(CA)});for(const key of ['HC_SOCKET','HERDR_SOCKET','CODEX_HOME','CLAUDE_CONFIG_DIR','GROK_CONFIG_DIR','GH_TOKEN','ANTHROPIC_API_KEY','QA_UNSELECTED'])assert.equal(env[key],undefined,key);const keys=${JSON.stringify(ordinary)}.filter(key=>before[key]!==undefined).concat(['HOME','USERPROFILE','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','HERDR_APP_HOME','HC_SESSION','DO_NOT_TRACK','HERDR_TELEMETRY','QA_GITHUB_WORK','QA_GITHUB_PERSONAL','NODE_EXTRA_CA_CERTS']).sort();assert.deepEqual(Object.keys(env).sort(),keys);console.log(JSON.stringify({pureImport:true,allowlistedChild:true}));`;
    const imported=await execute(process.execPath,['--input-type=module','-e',handoff],{env:importEnv,timeout:10000});assert.deepEqual(JSON.parse(imported.stdout),{pureImport:true,allowlistedChild:true});assert.equal(imported.stderr,'');
    fixtures=await githubFixtures(directory);await fs.mkdir(path.join(home,'mods'),{recursive:true});const built=await buildPackage(MOD);await fs.cp(built.directory,path.join(home,'mods',MOD),{recursive:true});const ca=path.join(directory,'both.pem');await fs.writeFile(ca,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    const env=isolatedEnvironment(directory,crypto.randomBytes(12).toString('hex'),process.env,{...fixtureEnvironment,NODE_EXTRA_CA_CERTS:ca});for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'])await fs.mkdir(env[key],{recursive:true,mode:0o700});
    const config=configuration({repo:'/fixture/local'},fixtures,{machine:'qa-server',repo:'/fixture/server'}),bindings=Object.values(config.bindings),input=(binding,operation)=>({v:1,operation,binding,connection:config.connections[binding.github.connectionId]});let assertions=2;
    for(const binding of bindings){const issues=await helper(home,env,input(binding,'issues'));assert.equal(issues.ok,true,JSON.stringify(issues));assert.deepEqual(issues.snapshot.data.map(i=>i.statusGroup),binding.machine?['todo','todo','done']:['todo','inProgress','done']);assertions++;const list=await helper(home,env,input(binding,'pulls'));assert.equal(list.ok,true,JSON.stringify(list));assert.equal(list.snapshot.data.length,11);assertions++;
      for(const [number,check]of [[42,p=>p.review.reason==='NO_REVIEW_DECISION'&&prActionAvailability(p,'review').enabled],[43,p=>prActionAvailability(p,'addressComments').enabled],[44,p=>prActionAvailability(p,'fixChecks').enabled],[45,p=>prActionAvailability(p,'fixChecks').reason==='FORK_READ_ONLY'],[46,p=>prActionAvailability(p,'review').reason==='REFS_UNAVAILABLE'],[47,p=>p.discussions.reason==='DISCUSSIONS_PARTIAL'&&prActionAvailability(p,'fixChecks').enabled],[48,p=>p.author.login===null],[49,p=>p.discussions.reason==='DISCUSSIONS_UNAVAILABLE'],[50,p=>p.state==='closed'],[51,p=>p.state==='merged'],[52,p=>p.draft]]){
        const selected=list.snapshot.data.find(p=>p.identity.number===number),reply=await helper(home,env,{...input(binding,'pulls'),cursor:prDetailCursor(selected)});assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(check(reply.snapshot.data[0]),true,'Native fixture case '+number);assertions++;
      }
    }
    fixtures.flags.large=true;const pageStart=fixtures.observed.length,large=await helper(home,env,input(bindings[0],'pulls'));assert.equal(large.ok,true,JSON.stringify(large));assert.equal(large.snapshot.data.length,120);assert.equal(large.snapshot.truncated,false);assert.deepEqual(fixtures.observed.slice(pageStart).filter(r=>r.large).map(r=>[r.page,r.perPage,r.returned]),[[1,50,50],[2,50,50],[3,50,20]]);assertions+=3;fixtures.flags.large=false;
    const original=await helper(home,env,input(bindings[0],'pulls')),selected=original.snapshot.data[0];fixtures.flags.changedHead={profile:'work',number:selected.identity.number};const changed=await helper(home,env,{...input(bindings[0],'pulls'),cursor:prDetailCursor(selected)});assert.equal(changed.ok,false);assert.equal(changed.error.code,'INVALID_SCOPE');assertions++;fixtures.flags.changedHead=null;
    fixtures.flags.denyWork=true;assert.equal((await helper(home,env,input(bindings[0],'issues'))).error.code,'PERMISSION_DENIED');fixtures.flags.denyWork=false;assertions++;
    const hold=fixtures.hold('personal',42),list=await helper(home,env,input(bindings[1],'pulls')),pending=helper(home,env,{...input(bindings[1],'pulls'),cursor:prDetailCursor(list.snapshot.data[0])});await until(()=>hold.entered,'owned fixture delayed detail');hold.release();assert.equal((await pending).ok,true);assertions++;
    assert.ok(fixtures.observed.filter(r=>r.path.startsWith('/api/')).every(r=>r.authorized));assert.ok(fixtures.observed.filter(r=>r.method==='POST').every(r=>r.queryName==='MissionControlPullDetail'));assertions+=2;
    const actorsFixture=await actors({directory,env:{HERDR_APP_HOME:home}});for(const program of Object.values(actorsFixture.programs)){const result=await execute(program.run[0],['--help'],{env});assert.ok(result.stdout.includes('--model'));assert.ok(!result.stdout.includes('--instructions'));assertions++;}
    // A disposable PTY verifies that the observation actor records received
    // bytes; it does not infer delivery from tab.new arguments alone.
    const task='Mission Control action: Fix failing checks\nGoal: Native fixture input proof.\n';
    const script=`import os,pty,time,select,sys,signal\nchild,fd=pty.fork()\nif child==0: os.execv(sys.argv[1],[sys.argv[1]])\ntry:\n ready=False\n until=time.monotonic()+5\n while time.monotonic()<until:\n  if select.select([fd],[],[],0.1)[0] and b'Disposable GitHub' in os.read(fd,8192): ready=True;break\n if not ready: raise RuntimeError('Actor never became ready')\n os.write(fd,sys.argv[2].encode())\n time.sleep(0.2)\nfinally:\n os.kill(child,signal.SIGTERM)\n os.waitpid(child,0)\n os.close(fd)\n`;
    await execute('python3',['-c',script,actorsFixture.programs.grok.run[0],task],{env,timeout:8000});assert.equal((await actorsFixture.read())[0].received,task);assertions++;
    await positionWindow({directory},{compileOnly:true});assertions++;
    return {ok:true,assertions,boundary:'Native scenario fixtures and copied standalone helper/PTY actor only. No Herdr app/core started, queried or stopped; no mounted interaction or preview claim.'};
  }finally{await fixtures?.close();await fs.rm(directory,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='fixture-check')throw Error('Use the approved native harness for a mounted run, or fixture-check for the core-free preflight.');
  checkFixtures().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
}
