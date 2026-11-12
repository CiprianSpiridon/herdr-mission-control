import {View,div} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import * as herdr from 'herdr';
import {createLaunchIO} from '../../shared/launch.js';
import {ReopenController,REOPEN_LIMITATIONS,REOPEN_COMMANDS} from '../../shared/reopen.js';
import {LIMITS} from '../../shared/closed-tabs.js';
import {RestartRunner,RUNNER} from '../../shared/restart-runner.js';
import {colors,label,icon,iconButton} from '../../shared/ui.js';

const MOD='mission-control-reopen',COMMAND_EVENT='mission-control-reopen-command-v1',COMMANDS=new Set([...Object.keys(REOPEN_COMMANDS),'open','help','import']);
const RECOVERY={retry:'Retry','retry-binding':'Retry','retry-uncertain':'Open it anyway',dismiss:'Forget it',locate:'Show its space','close-existing-and-retry':'Show running agent','import-history':'Import older history'};
const NOTICES={'agent-not-resumed':'Opened as a shell: the agent had no exact session.','panes-not-restored':'Only its main pane came back.','names-not-transferred':'Its saved name could not be restored.','scaffold-tab-kept':'A helper shell tab stayed open.'};
const ago=(at,now)=>{const s=Math.max(0,Math.round((now-at)/1000));return s<60?'just now':s<3600?Math.floor(s/60)+' min ago':s<86400?Math.floor(s/3600)+' h ago':Math.floor(s/86400)+' d ago';};
const kindLabel=kind=>kind==='agent'?'Reopen last agent':'Reopen last tab',IMPORT_STALE_MS=LIMITS.historyMs*LIMITS.hosts+30000;
/** Shown in help next to the reopen limits: what resume after restart does and does not bring back. */
export const RESTART_HELP=Object.freeze([
  'After a reboot, logout or Herdr core crash, Herdr brings each terminal back as a plain shell. Mission Control then types the agent\u2019s own resume command with its exact session ID into that shell (for example claude --resume <id>), so each agent comes back in the tab it ran in.',
  'Agents you quit stay closed. An agent that crashes inside a tab returns you to that tab\u2019s shell, which looks exactly like quitting, so it is not resumed.',
  'It types only into a sh, bash, zsh, dash or ksh shell that is still idle, in the same folder, less than 15 minutes after the shell came back. Otherwise it offers Resume here instead.',
  'Codex sessions are learned through a small Codex hook. Use Set up Codex resume; Codex then asks you to trust the hook once. Start Codex with --no-daemon so the hook runs in your terminal.',
  'Turn it off with "resumeAfterRestart": false under preferences in mission-control/config.json.'
]);

export default class MissionControlReopen extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view==='help'?'help':this.props.view==='popup'||this.props.overlay?'popup':'bar';
    this.closed=false;this.jobs=[];this.timers=[];this.status=null;this.polling=0;this.importing=0;this.importStatus=null;this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    if(this.role==='help')return;
    this.io=createLaunchIO(herdr);this.controller=new ReopenController(this.io,{owner:MOD+'-'+this.instance});
    this.runner=new RestartRunner(this.io,{owner:MOD+'-'+this.instance+'-restart'});this.restarting=0;this.restartStatus=null;
    // Every docked copy ticks; the shared CAS lease lets exactly one of them observe closes per app home.
    this.poll(cx,{force:true});this.timers.push(cx.timer.every(LIMITS.observeMs,eventCx=>this.poll(eventCx)));
    // Resume after restart has its own cadence; only a docked bar observes, a popup only reads and acts.
    if(this.role==='bar')this.timers.push(cx.timer.every(RUNNER.tickMs,eventCx=>this.restartTick(eventCx)));
    this.spawn(cx,async()=>{if(this.role==='bar')await this.runner.tick();else await this.runner.refresh();await this.runner.refreshCodex();});
    this.commandTask=cx.spawn(async(taskCx)=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;this.command(command,taskCx);}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());
    const job=cx.spawn(async(taskCx)=>{let changed=true;try{changed=(await work(taskCx))!==false;}catch{this.status={kind:null,result:{ok:false,code:'REOPEN_FAILED',message:'Reopen could not complete; closed tabs were kept.',recovery:{actions:[]}},at:Date.now()};}if(!this.closed&&changed)taskCx.notify();});
    this.jobs.push(job);return job;
  }
  // Lease renewals rewrite the journal every few seconds; only record changes redraw the window.
  fingerprint(){const v=this.controller.value;return JSON.stringify([v?v.records.map(r=>[r.id,r.claim?.until??0,r.error?.code??null]):null,this.controller.error?.code??null]);}
  poll(cx,{force=false}={}){
    if(this.closed)return;const now=Date.now();
    // An interrupted poll never clears its flag; it simply expires.
    if(this.polling&&now-this.polling<LIMITS.tickStaleMs)return;this.polling=now;const before=this.fingerprint();
    return this.spawn(cx,async()=>{if(this.role==='bar')await this.controller.tick();else await this.controller.refresh();this.polling=0;return force||this.fingerprint()!==before;});
  }
  command(command,cx){
    if(!COMMANDS.has(command))return;
    // A key command reaches every shown copy; only the first copy to take it acts.
    const now=Date.now(),seen=herdr.shared(COMMAND_EVENT);
    if(seen?.command===command&&seen.owner!==this.instance&&now-seen.at>=0&&now-seen.at<750)return;
    herdr.setShared(COMMAND_EVENT,{v:1,command,owner:this.instance,at:now});
    if(REOPEN_COMMANDS[command])return this.act(REOPEN_COMMANDS[command],cx,{fromKey:true});
    if(command==='open')return this.openPopup();if(command==='help')return this.openHelp();return this.importHistory(cx);
  }
  act(kind,cx,{recordId,confirmUncertain=false,fromKey=false}={}){
    if(this.closed||!this.controller||this.controller.running())return;
    this.status={kind,recordId:recordId??null,pending:true,at:Date.now()};cx.notify();
    return this.spawn(cx,async()=>{
      const result=await this.controller.run(kind,{recordId,confirmUncertain});if(this.closed)return false;
      this.status={kind,recordId:recordId??result.recordId??result.recovery?.recordId??null,result,at:Date.now()};
      if(!result.ok&&fromKey&&result.code!=='REOPEN_IN_PROGRESS')herdr.notify({title:kindLabel(kind),body:result.message,level:'warning'});
      if(result.ok&&this.role==='popup'&&this.props.overlay)herdr.closeOverlay(this.props.overlay);
    });
  }
  restartFingerprint(){return JSON.stringify([this.runner.offers().map(o=>[o.machine,o.address,o.reason]),this.runner.codexSetup(),this.runner.error?.code??null]);}
  restartTick(cx){
    if(this.closed||!this.runner)return;const now=Date.now();if(this.restarting&&now-this.restarting<RUNNER.staleTickMs)return;this.restarting=now;const before=this.restartFingerprint();
    return this.spawn(cx,async()=>{await this.runner.tick();this.restarting=0;return this.restartFingerprint()!==before;});
  }
  restartAct(work,cx){
    if(this.closed||!this.runner)return;this.restartStatus='Working…';cx.notify();
    return this.spawn(cx,async()=>{const message=await work();if(this.closed)return false;this.restartStatus=message||null;});
  }
  resumeOffers(cx,offer){return this.restartAct(async()=>{const results=offer?[await this.runner.resumeOffer(offer)]:await this.runner.resumeAll();const failed=results.filter(r=>!r.ok);
    return failed.length?failed.map(r=>r.reason+(r.line?' Run: '+r.line:'')).join(' '):`Resumed ${results.length} agent${results.length===1?'':'s'}.`;},cx);}
  dismissOffer(cx,offer){return this.restartAct(async()=>{for(const o of offer?[offer]:this.runner.offers())await this.runner.dismissOffer(o);return null;},cx);}
  setupCodex(cx,machine){return this.restartAct(async()=>{const r=await this.runner.installCodex(machine);return r.ok?'Codex resume is set up. Codex asks you to trust the new hook the next time it starts.':r.message;},cx);}
  record(id){return this.controller.value?.records.find(r=>r.id===id)||null;}
  recover(action,cx){
    const s=this.status,r=s?.result,id=s?.recordId;if(!r||r.ok)return;
    if(action==='retry'||action==='retry-binding')return this.act(s.kind||'tab',cx,{recordId:id||undefined});
    if(action==='retry-uncertain'&&id)return this.act(s.kind||'tab',cx,{recordId:id,confirmUncertain:true});
    if(action==='dismiss'&&id)return this.dismiss(id,cx);
    if(action==='import-history')return this.importHistory(cx);
    if(action==='locate'||action==='close-existing-and-retry'){const tab=r.recovery?.tabId||r.recovery?.candidates?.[0]?.tabId,rec=this.record(id);if(tab)herdr.run('tab.select',{id:tab});else if(rec)herdr.run('space.select',{id:rec.space.replacement||rec.space.id});}
  }
  dismiss(id,cx){if(this.closed)return;return this.spawn(cx,async()=>{const result=await this.controller.dismiss(id);if(this.closed)return false;this.status=result.ok?null:{kind:null,recordId:id,result,at:Date.now()};});}
  importHistory(cx){
    const now=Date.now();if(this.closed||!this.controller||this.importing&&now-this.importing<IMPORT_STALE_MS)return;this.importing=now;this.importStatus='Importing older history…';cx.notify();
    return this.spawn(cx,async()=>{const results=await this.controller.importHistory();this.importing=0;if(this.closed)return false;this.importStatus=results.map(r=>r.message).join(' ')||'No machines to import from.';});
  }
  openPopup(){herdr.openOverlay({mod:MOD,kind:'popup',width:340,height:440,props:{view:'popup'}});}
  openHelp(){herdr.openOverlay({mod:MOD,kind:'dialog',width:520,height:460,props:{view:'help'}});}
  tooltip(p){return [p.label+(p.title?': '+p.title:''),p.detail,p.imported?'Imported history':null,p.reason,p.lastError?'Last attempt: '+p.lastError:null].filter(Boolean).join('\n');}
  link(id,text,action,{disabled=false}={}){
    const t=colors();let el=div().id(id).text_size(11).text_color(disabled?t.dim:t.accent).role('button').accessibility_label(text).on_mouse_down('left',(_e,cx)=>cx.stop_propagation());
    if(!disabled)el=el.cursor_pointer().hover(s=>s.text_color(t.foreground)).on_click((e,cx)=>{cx.stop_propagation();return action(e,cx);});
    return el.child(text);
  }
  pill(id,text,preview,action){
    const t=colors(),enabled=preview.state==='ready'&&!this.controller.running();
    let el=h_flex().id(id).h(20).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(enabled?t.surface:'#00000000').text_color(enabled?t.foreground:t.dim).role('button').accessibility_label(text).tooltip(this.tooltip(preview)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation());
    if(enabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click(action);
    return el.child(text);
  }
  statusLine(tab){
    const s=this.status;
    if(s?.pending)return s.kind==='agent'?'Reopening last agent…':'Reopening last tab…';
    if(s?.result)return s.result.ok?`Reopened ${s.result.title} · ${s.result.destination}`:s.result.message;
    if(this.controller.error)return this.controller.error.message;
    if(tab.state==='ready')return `Last closed: ${tab.title} · ${tab.detail}`;
    if(tab.state==='loading')return 'Reading closed tabs…';
    if(tab.state==='partial')return 'Older history is partial: choose a tab in More.';
    return 'Nothing closed yet';
  }
  bar(){
    const t=colors(),tab=this.controller.preview('tab'),agent=this.controller.preview('agent'),failed=this.status?.result&&!this.status.result.ok;
    return h_flex().id('reopen-bar').size_full().px(8).gap(6).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11)
      .child(icon(MOD,'sessions',13).text_color(t.dim))
      .child(this.pill('reopen-tab','Reopen tab',tab,(_e,cx)=>this.act('tab',cx)))
      .child(this.pill('reopen-agent','Reopen agent',agent,(_e,cx)=>this.act('agent',cx)))
      .when(this.runner.offers().length>0,e=>e.child(this.restartPill()))
      .child(div().id('reopen-status').flex_1().min_w(0).truncate().text_color(failed?t.blocked:t.muted).child(this.statusLine(tab)))
      .child(iconButton(MOD,'reopen-more','more','Closed tabs and recovery',()=>this.openPopup(),{size:22}))
      .child(this.link('reopen-help','Help',()=>this.openHelp()));
  }
  action(id,name,preview,handler){
    const t=colors(),enabled=preview.state==='ready'&&!this.controller.running(),detail=['ready','busy'].includes(preview.state)?[preview.title,preview.detail,preview.imported?'imported':null].filter(Boolean).join(' · '):preview.reason;
    let el=h_flex().id(id).p(8).gap(9).items_center().rounded(6).border(1).border_color(t.border).role('button').accessibility_label(preview.label).tooltip(this.tooltip(preview)).text_color(enabled?t.foreground:t.dim);
    if(enabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click(handler);
    return el.child(icon(MOD,name,16).text_color(enabled?t.accent:t.dim))
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12).child(preview.label)).child(div().text_size(10).text_color(t.muted).truncate().child(detail||''))
        .when(Boolean(preview.reason)&&['ready','unsupported'].includes(preview.state)&&detail!==preview.reason,e=>e.child(div().text_size(10).text_color(preview.state==='ready'?t.dim:t.blocked).child(preview.reason))));
  }
  restartPill(){
    const t=colors(),n=this.runner.offers().length,text=`Resume ${n} agent${n===1?'':'s'}`;
    return h_flex().id('restart-resume').h(20).px(8).items_center().rounded(5).border(1).border_color(t.accent).bg(t.surface).text_color(t.foreground).role('button').accessibility_label(text+' from before the restart')
      .tooltip(['From before the restart:',...this.runner.offers().map(o=>o.line+(o.reason?'\n  '+o.reason:''))].join('\n')).cursor_pointer().hover(s=>s.bg(t.hover))
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();this.resumeOffers(cx);}).child(text);
  }
  restartSection(){
    const t=colors(),list=this.runner.offers(),codex=this.runner.codexSetup().filter(c=>c.ok&&!c.installed);
    if(!list.length&&!codex.length&&!this.restartStatus)return null;
    return v_flex().id('restart-section').flex_none().gap(4)
      .when(list.length>0,e=>e.child(h_flex().gap(8).items_center().child(label('From before the restart',{muted:true,size:10})).child(div().flex_1()).child(this.link('restart-resume-all','Resume all',(_e,cx)=>this.resumeOffers(cx))).child(this.link('restart-dismiss-all','Dismiss',(_e,cx)=>this.dismissOffer(cx))))
        .children(list.map((o,i)=>h_flex().id('restart-offer-'+i).min_h(34).px(6).gap(8).items_center().rounded(5).border(1).border_color(t.border)
          .child(icon(MOD,'agent',14).text_color(t.dim))
          .child(v_flex().flex_1().min_w(0).child(div().truncate().text_color(t.foreground).child(o.line)).child(div().truncate().text_size(10).text_color(t.dim).child([o.machine||'This Mac',o.reason].filter(Boolean).join(' · '))))
          .child(this.link('restart-offer-resume-'+i,'Resume',(_e,cx)=>this.resumeOffers(cx,o))).child(iconButton(MOD,'restart-offer-dismiss-'+i,'close','Dismiss',(_e,cx)=>this.dismissOffer(cx,o),{size:22})))))
      .children(codex.map((c,i)=>h_flex().id('restart-codex-'+i).gap(8).items_center().child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(`Codex on ${c.machine||'this Mac'} can come back after a restart once its session hook is set up.`)).child(this.link('restart-codex-setup-'+i,'Set up Codex resume',(_e,cx)=>this.setupCodex(cx,c.machine)))))
      .when(Boolean(this.restartStatus),e=>e.child(div().id('restart-status').text_size(10).text_color(t.muted).child(this.restartStatus)));
  }
  statusBlock(){
    const t=colors(),s=this.status;
    if(s.pending)return div().id('reopen-progress').text_size(11).text_color(t.muted).child(s.kind==='agent'?'Reopening last agent…':'Reopening last tab…');
    const r=s.result,notes=r.ok?(r.notices||[]).map(n=>NOTICES[n]).filter(Boolean):[];
    return v_flex().id('reopen-result').p(8).gap(6).rounded(6).border(1).border_color(r.ok?t.border:t.blocked)
      .child(h_flex().gap(6).items_center().child(icon(MOD,r.ok?'check':'close',13).text_color(r.ok?t.done:t.blocked)).child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).child(r.ok?`Reopened ${r.title} · ${r.destination}`:r.message)))
      .children(notes.map((note,i)=>div().id('reopen-notice-'+i).text_size(10).text_color(t.muted).child(note)))
      .when(!r.ok&&Boolean(r.recovery?.actions?.some(a=>RECOVERY[a])),e=>e.child(h_flex().gap(12).children(r.recovery.actions.filter(a=>RECOVERY[a]&&(a!=='dismiss'||s.recordId)).map(a=>this.link('recover-'+a,RECOVERY[a],(_e,cx)=>this.recover(a,cx))))));
  }
  row(r,now){
    const t=colors(),busy=r.busy||this.controller.running(),note=r.kind==='agent'&&!r.exact?'No exact session: opens a shell in its folder':null;
    let el=h_flex().id('recent-'+r.id).h(34).px(6).gap(8).items_center().rounded(5).role('button').accessibility_label('Reopen '+r.title)
      .tooltip([r.title,r.destination,r.imported?(r.ordered?'Imported history':'Imported history · order unverified'):null,note,r.error?'Last attempt: '+r.error:null].filter(Boolean).join('\n'));
    if(!busy)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>this.act('tab',cx,{recordId:r.id}));
    return el.child(icon(MOD,r.kind==='agent'?'agent':'folder',14).text_color(t.dim))
      .child(v_flex().flex_1().min_w(0).child(div().truncate().text_color(t.foreground).child(r.title)).child(div().truncate().text_size(10).text_color(r.error?t.blocked:t.dim).child([r.destination,r.imported?(r.ordered?'imported':'imported · order unverified'):ago(r.closedAt,now),r.error].filter(Boolean).join(' · '))))
      .child(iconButton(MOD,'forget-'+r.id,'close','Forget this closed tab',(_e,cx)=>this.dismiss(r.id,cx),{size:22,disabled:r.busy}));
  }
  popup(){
    const t=colors(),tab=this.controller.preview('tab'),agent=this.controller.preview('agent'),rows=this.controller.recent(6),now=Date.now();
    // Herdr can give the popup less than its requested height; scroll the whole popup so the list never collapses to nothing.
    return v_flex().id('reopen-popup').size_full().overflow_y_scrollbar().p(10).gap(8).bg(t.surface).text_size(12)
      .child(h_flex().h(24).gap(6).items_center().child(icon(MOD,'sessions',15).text_color(t.muted)).child(label('Reopen',{size:13})).child(div().flex_1()).child(this.link('popup-help','Help',()=>this.openHelp()))
        .when(Boolean(this.props.overlay),e=>e.child(iconButton(MOD,'popup-close','close','Close',()=>herdr.closeOverlay(this.props.overlay),{size:22}))))
      .child(this.action('popup-reopen-tab','sessions',tab,(_e,cx)=>this.act('tab',cx)))
      .child(this.action('popup-reopen-agent','agent',agent,(_e,cx)=>this.act('agent',cx)))
      .when(Boolean(this.status),e=>e.child(this.statusBlock()))
      .when(Boolean(this.restartSection()),e=>e.child(this.restartSection()))
      .when(Boolean(this.controller.error),e=>e.child(div().id('reopen-error').text_size(11).text_color(t.blocked).child(this.controller.error.message)))
      .child(label('Recently closed',{muted:true,size:10}))
      .child(rows.length?v_flex().id('reopen-recent').flex_none().gap(2).children(rows.map(r=>this.row(r,now)))
        :v_flex().id('reopen-empty').flex_none().p(12).gap(6).items_center().child(label('Nothing to reopen yet')).child(div().text_size(11).text_color(t.muted).child('Tabs you close while this bar or the Mission Control tab bar runs appear here. Import older history to look further back.')))
      .child(h_flex().gap(8).items_center().child(this.link('reopen-import',this.importing?'Importing…':'Import older history',(_e,cx)=>this.importHistory(cx),{disabled:Boolean(this.importing)})).child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.importStatus||'')));
  }
  help(){
    const t=colors();
    return v_flex().id('reopen-help-view').size_full().p(18).gap(10).bg(t.surface).text_size(12)
      .child(h_flex().gap(8).items_center().child(icon(MOD,'sessions',16).text_color(t.muted)).child(label('Reopen: what comes back',{size:14})).child(div().flex_1())
        .when(Boolean(this.props.overlay),e=>e.child(iconButton(MOD,'help-close','close','Close',()=>herdr.closeOverlay(this.props.overlay)))))
      .child(v_flex().id('reopen-limitations').flex_1().min_h(0).overflow_y_scrollbar().gap(8).children([...REOPEN_LIMITATIONS,...RESTART_HELP].map((line,i)=>h_flex().id('limitation-'+i).gap(8).items_start().child(div().mt(6).size(4).rounded_full().flex_none().bg(t.dim)).child(div().flex_1().min_w(0).text_color(t.muted).child(line)))));
  }
  render(){if(this.role==='help')return this.help();return this.role==='popup'?this.popup():this.bar();}
  close(){
    this.closed=true;for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();
    // Best effort: an unreleased lease simply expires, so another copy takes over within seconds.
    if(this.role==='bar'&&this.controller)return Promise.all([this.controller.release().catch(()=>{}),this.runner?.release().catch(()=>{})]);
  }
}
