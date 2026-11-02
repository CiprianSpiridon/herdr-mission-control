import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {launch,createLaunchIO} from '../src/shared/launch.js';
import {parseCapabilities} from '../src/shared/tool-capabilities.js';
import {BindingStore} from '../src/shared/session-bindings.js';
const child=(cmd,args,options={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:options.cwd});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-launch-'))),repo=path.join(root,'repo');await fs.mkdir(repo);
 for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])assert.equal((await child('git',['-C',repo,...args])).code,0);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let count=0,now=1000,malformed=false,failCommit=false,appendTask=false,extraArg=null,shellFirst=0,prefix=['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh'];const effects=[],calls=[],raws=new Map(),world={spaces:[{id:'space-A',name:'client-portal',machine:null,folder:repo,tabs:[]}]};
 const tools=['claude','codex','grok'].map(key=>({key,name:key,run:['qa-'+key],installed:true}));
 const io={appHome:root,clock:()=>now,spaces:()=>world.spaces,knownAgents:async()=>tools,run:(...args)=>effects.push(args),sessionSource:async provider=>({providerRoot:root+'/.providers/'+provider,credentialScope:'fixture'}),delay:async()=>{},
  capabilities:{get:async tool=>parseCapabilities(tool,{help:tool.key==='claude'?'Claude Code\nUsage: claude [options] [prompt]\n --session-id <uuid>\n --resume [value]\n --model <model>\n --append-system-prompt <prompt>':tool.key==='grok'?'Grok Build TUI\nUsage: grok [OPTIONS] [PROMPT]\n --session-id <SESSION_ID>\n --resume [<SESSION_ID_OR_TITLE>]\n --model <MODEL>':'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --no-daemon\n --model <MODEL>',resumeHelp:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'})},
  readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:dir=>fs.mkdir(dir,{recursive:true}),
  writeTextFile:async(file,next,expected)=>{
   if(failCommit&&file.endsWith('session-bindings.json')&&Object.values(JSON.parse(next).proposals).some(r=>r.state==='committed')){failCommit=false;throw Object.assign(Error('injected disk failure'),{code:'EACCES'});}
   let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,next);
  },
  exec:async(cmd,args,options={})=>{
   calls.push({cmd,args,options});
   if(cmd==='herdr-app'&&args[0]==='do'){
    assert.equal(args[1],'tab.new');const input=JSON.parse(args[2]),space=world.spaces.find(s=>s.id===input.space);assert.ok(space);count++;
    const tab='tab-'+count,address='t'+count;space.tabs.push({id:tab,name:input.name,named:true,terminals:[{terminal:address}]});
    raws.set(address,{address,created_ms:100+count,pid:400+count,shellReads:shellFirst,foreground:{pid:500+count},argv:[...prefix,...input.argv,...(appendTask&&input.task?[input.task]:[]),...(extraArg?[extraArg]:[])],labels:{'herdr.space':space.id,'herdr.tab':tab}});
    return {code:0,stdout:malformed?'not-json':JSON.stringify({space:space.id,tab,terminal:address})};
   }
   if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
   if(cmd==='hc'&&args[0]==='get'){
    // The wrapper shell holds the foreground for its first reads, as Herdr 0.1.11's /bin/sh does before its job starts.
    const raw=raws.get(args[1]);if(raw?.shellReads>0){raw.shellReads--;const {shellReads,...shown}=raw;return {code:0,stdout:JSON.stringify({...shown,foreground:{pid:raw.pid}})};}
    const {shellReads,...shown}=raw||{};return {code:0,stdout:JSON.stringify(raw?shown:undefined)};
   }
   assert.equal(options.on??null,null);return child(cmd,args,options);
  }};
 return {root,repo,io,world,raws,effects,calls,count:()=>count,setTime:n=>now=n,malform:()=>malformed=true,failCommit:()=>failCommit=true,setShell:(path,repeat=path)=>prefix=[path,'-lic','"$@"; exec "$0" -li',repeat],setPrefix:value=>prefix=value,shellFirst:n=>shellFirst=n,appendTask:()=>appendTask=true,extraArg:value=>extraArg=value};
}
const request=(repo,id='A')=>({requestId:id,idempotencyKey:id,originId:'origin-'+id,spaceId:'space-A',machine:null,repoRoot:repo,checkoutRoot:repo,toolKey:'claude',worktree:false});
const issue=()=>({kind:'jira',connectionId:'work',site:'https://jira.example.invalid',id:'10001',key:'WEB-142',title:'Fix login redirect',url:'https://jira.example.invalid/browse/WEB-142',body:'Steps to reproduce; `$(this is task data)`'});
test('independent generic intents create separate acknowledged tabs; repeats focus the exact existing tab',async t=>{
 const f=await fixture(t);const a=await launch(request(f.repo),f.io);assert.equal(a.ok,true,JSON.stringify(a));assert.equal(a.reused,false);
 const b=await launch(request(f.repo,'B'),f.io);assert.equal(b.ok,true,JSON.stringify(b));assert.notEqual(a.tabId,b.tabId);assert.equal(f.count(),2);
 const repeat=await launch(request(f.repo),f.io);assert.equal(repeat.ok,true,JSON.stringify(repeat));assert.equal(repeat.tabId,a.tabId);assert.equal(repeat.reused,true);assert.equal(f.count(),2);assert.deepEqual(f.effects.at(-2),['tab.select',{id:a.tabId}]);
 const fresh=new BindingStore(f.io,{clock:f.io.clock});const full=await fresh.readCommitted({machine:null,address:a.terminalId,createdMs:101,foregroundPid:501});assert.equal(full.session.sessionId,a.session.sessionId);
});
test('exact-session proof accepts Herdr 0.1.11 local /bin/sh, remote sh -c and other-prefix shell wrappers, never a non-shell or mismatched wrapper',async t=>{
 const f=await fixture(t);
 for(const[id,shell]of [['sh','/bin/sh'],['brew','/opt/homebrew/bin/bash']]){f.setShell(shell);const r=await launch(request(f.repo,id),f.io);assert.equal(r.ok,true,shell+' '+JSON.stringify(r));}
 for(const[id,shell,repeat]of [['python','/usr/bin/python3','/usr/bin/python3'],['mismatch','/bin/sh','/bin/zsh'],['relative','bin/sh','bin/sh']]){f.setShell(shell,repeat);const r=await launch(request(f.repo,id),f.io);assert.equal(r.code,'UNPROVEN_SESSION',id+' '+JSON.stringify(r));}
 // Herdr 0.1.11 on a remote host: a bare `sh -c` wrapper that keeps the shell in the foreground.
 f.setPrefix(['sh','-c','"$@"; exec "${SHELL:-sh}" -i','sh']);assert.equal((await launch(request(f.repo,'remote'),f.io)).ok,true);
 for(const[id,prefix]of [['remote-script',['sh','-c','"$@"; exec "$0" -li','sh']],['remote-repeat',['sh','-c','"$@"; exec "${SHELL:-sh}" -i','bash']]]){f.setPrefix(prefix);assert.equal((await launch(request(f.repo,id),f.io)).code,'UNPROVEN_SESSION',id);}
});
test('Herdr 0.1.11 appends the sent task as the last argument; exact-session proof accepts only that exact task',async t=>{
 const f=await fixture(t);f.appendTask();const sent=await launch({...request(f.repo,'task-arg'),source:issue()},f.io);assert.equal(sent.ok,true,JSON.stringify(sent));
 f.extraArg('--dangerously-skip-permissions');const extra=await launch({...request(f.repo,'task-extra'),source:{...issue(),key:'WEB-143',id:'10002'}},f.io);assert.equal(extra.code,'UNPROVEN_SESSION',JSON.stringify(extra));
});
test('concurrent same qualified issue creates one real worktree/tab and task prose remains argv data',async t=>{
 const f=await fixture(t),r={...request(f.repo),worktree:true,source:issue()};const results=await Promise.all([launch(r,f.io),launch({...r,requestId:'other-click',idempotencyKey:'other-click',originId:'other-origin'},f.io)]);
 assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));assert.equal(f.count(),1);const success=results.find(r=>r.ok);assert.match(success.folder,/client-portal-WEB-142$/);
 const again=await launch({...r,requestId:'third-click',idempotencyKey:'third-click',originId:'third-origin',source:{...issue(),key:'WEB-999'}},f.io);assert.equal(again.ok,true,JSON.stringify(again));assert.equal(again.tabId,success.tabId);assert.equal(f.count(),1);
 const call=f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do');const parsed=JSON.parse(call.args[2]);assert.match(parsed.task,/\$\(this is task data\)/);assert.ok(Array.isArray(parsed.argv));
 assert.ok(f.calls.filter(c=>c.cmd==='git').every(c=>!c.args.some(a=>a.includes('task data'))));
});
test('malformed acknowledgment retains uncertain creation and a retry never spawns a second tab',async t=>{
 const f=await fixture(t);f.malform();const a=await launch(request(f.repo),f.io);assert.equal(a.ok,false);assert.equal(a.code,'MALFORMED_ACK');assert.equal(f.count(),1);
 f.setTime(40000);const b=await launch(request(f.repo),f.io);assert.equal(b.code,'RECOVERY_REQUIRED');assert.equal(f.count(),1);
 const journal=JSON.parse(await fs.readFile(f.root+'/mission-control/launches.json'));assert.equal(journal.requests.A.state,'recovery-required');
});
test('binding failure after tab creation retries only the exact committed acknowledgment',async t=>{
 const f=await fixture(t);f.failCommit();const a=await launch(request(f.repo),f.io);assert.equal(a.ok,false);assert.equal(f.count(),1);assert.equal(a.recovery.tabId,'tab-1');
 const b=await launch(request(f.repo),f.io);assert.equal(b.ok,true,JSON.stringify(b));assert.equal(b.reused,true);assert.equal(f.count(),1);assert.equal(b.tabId,'tab-1');
 const journal=JSON.parse(await fs.readFile(f.root+'/mission-control/launches.json'));assert.equal(journal.requests.A.state,'complete');
});
test('different tools require an explicit separate worktree and invalid options/hosts have zero creation',async t=>{
 const f=await fixture(t),r={...request(f.repo),source:issue()};assert.equal((await launch(r,f.io)).ok,true);
 const other=await launch({...r,requestId:'B',idempotencyKey:'B',originId:'origin-B',toolKey:'codex'},f.io);assert.equal(other.code,'ISSUE_TOOL_CONFLICT');assert.equal(f.count(),1);
 const invalid=await launch({...request(f.repo,'C'),toolKey:'codex',reasoning:'high'},f.io);assert.equal(invalid.code,'UNSUPPORTED_OPTION');assert.equal(f.count(),1);
 const wrong=await launch({...request(f.repo,'D'),machine:'server'},f.io);assert.equal(wrong.code,'SPACE_UNAVAILABLE');assert.equal(f.count(),1);
 const separate=await launch({...r,requestId:'separate',idempotencyKey:'separate',originId:'origin-separate',toolKey:'codex',worktree:true,worktreePath:f.root+'/separate',branch:'mission-control/separate'},f.io);assert.equal(separate.ok,true,JSON.stringify(separate));assert.equal(f.count(),2);
});
test('captured linked checkout executes there while canonical repo identity remains stable',async t=>{
 const f=await fixture(t),linked=f.root+'/linked';assert.equal((await child('git',['-C',f.repo,'worktree','add','-b','linked',linked,'HEAD'])).code,0);
 const missing=await launch({...request(f.repo),checkoutRoot:undefined},f.io);assert.equal(missing.code,'INVALID_LAUNCH');assert.equal(f.count(),0);
 assert.equal(f.calls.length,0);
 const result=await launch({...request(f.repo),checkoutRoot:linked},f.io);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.folder,linked);
 const journal=JSON.parse(await fs.readFile(f.root+'/mission-control/launches.json'));assert.equal(journal.requests.A.request.repoRoot,f.repo);assert.equal(journal.requests.A.request.checkoutRoot,linked);
});
test('closed or replaced tabs cannot be recreated by replay; a finished foreground can still be focused safely',async t=>{
 const f=await fixture(t),r=request(f.repo);const a=await launch(r,f.io);assert.equal(a.ok,true);f.raws.get('t1').foreground.pid=777;
 const ended=await launch(r,f.io);assert.equal(ended.ok,true,JSON.stringify(ended));assert.equal(ended.session,null);assert.equal(f.count(),1);
 f.world.spaces[0].tabs=[];const closed=await launch(r,f.io);assert.equal(closed.code,'PREVIOUS_SESSION_CLOSED');assert.equal(f.count(),1);
});
test('native launch IO selects exactly one explicit enabled profile and never guesses among accounts/hosts',async t=>{
 const f=await fixture(t),io=createLaunchIO(f.io),file=f.root+'/mission-control/config.json';await fs.mkdir(path.dirname(file),{recursive:true});
 const config={v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:{work:{v:1,enabled:true,provider:'claude',machine:null,providerRoot:'/profiles/work/.claude',credentialScope:'work',roots:['/profiles/work/.claude/projects']}}};
 await fs.writeFile(file,JSON.stringify(config));assert.deepEqual(await io.sessionSource('claude',null),{providerRoot:'/profiles/work/.claude',credentialScope:'work'});assert.equal(await io.sessionSource('claude','server'),null);
 config.usageSources.personal={...config.usageSources.work,providerRoot:'/profiles/personal/.claude',credentialScope:'personal'};await fs.writeFile(file,JSON.stringify(config));assert.equal(await io.sessionSource('claude',null),null);
 config.usageSources.work.enabled=false;config.usageSources.personal.enabled=false;await fs.writeFile(file,JSON.stringify(config));assert.equal(await io.sessionSource('claude',null),null);
});

test('a local login-shell tab binds its program, not the wrapper shell that briefly holds the foreground',async t=>{
 const f=await fixture(t);f.setShell('/bin/sh');f.shellFirst(3);
 const r=await launch(request(f.repo,'shell-first'),f.io);assert.equal(r.ok,true,JSON.stringify(r));
 const store=JSON.parse(sync.readFileSync(f.root+'/mission-control/session-bindings.json','utf8')),bound=Object.values(store.proposals).find(x=>x.state==='committed');
 assert.ok(bound,'the binding is committed');assert.equal(bound.ack.terminal.foregroundPid,500+f.count(),'the agent, not the shell (pid '+(400+f.count())+'), is bound');
});
