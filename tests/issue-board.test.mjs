import test from 'node:test';
import assert from 'node:assert/strict';
import {IssueBoardState,renderIssueBoard,issueCardId} from '../src/shared/issue-board.js';
import {injectNative,trigger,findElement,context,Element} from './support/native-recording.mjs';

const NOW=1800000000000,MOD='mission-control-jira',ID='jira-board';
const program=key=>({key,name:{claude:'Claude Code',codex:'Codex',grok:'Grok',kiro:'Kiro'}[key]||key,installed:true,run:['qa-'+key],icon:'icons/'+key+'.svg',tint:key==='claude'});
const issue=(n=142,statusGroup='todo',overrides={})=>({identity:{kind:'jira',connectionId:'work',site:'https://work.atlassian.net',id:String(10000+n)},key:'WEB-'+n,title:'Fix login redirect '+n,url:'https://work.atlassian.net/browse/WEB-'+n,body:'Actual task data.',statusGroup,statusName:{todo:'Open',inProgress:'Developing',done:'Resolved'}[statusGroup],priority:'High',repoBinding:{machine:null,repoRoot:'/repos/client-portal',jira:{connectionId:'work',project:'WEB'}},...overrides});
function nodes(root){const result=[];function walk(value){if(!(value instanceof Element))return;result.push(value);value.nodes.forEach(walk);}walk(root);return result;}
const strings=root=>nodes(root).flatMap(el=>el.nodes.filter(v=>typeof v==='string'));
const ids=root=>nodes(root).map(el=>el.semanticId).filter(Boolean);
function fixture(options={}){
  injectNative();const rows=[issue(142),issue(143,'inProgress'),issue(144,'done')],events=[],state=new IssueBoardState(),cx=context();let stopped=0;cx.stop_propagation=()=>stopped++;
  const props={id:ID,mod:MOD,state,width:1050,now:NOW,view:{state:'ready',all:false,data:rows,bindings:[{snapshot:{fetchedAt:NOW-120000}}],errors:[],loading:0,truncated:false,limitReached:false},toolsForMachine:()=>['claude','codex','grok','kiro'].map(program),preferences:{pins:['claude','codex','grok']},onOpenIssue:(row)=>events.push(['open',row]),onLaunch:(row,key)=>events.push(['launch',row,key]),onOptions:(row)=>events.push(['options',row]),onSetup:(binding)=>events.push(['setup',binding]),onRefresh:()=>events.push(['refresh']),onScopeChange:all=>events.push(['scope',all]),onLoadMore:()=>events.push(['more']),onInvalid:message=>events.push(['invalid',message]),...options};
  return {props,rows:props.view.data,state:props.state,cx,events,stopped:()=>stopped,render:()=>renderIssueBoard(props,cx)};
}

test('default board uses three compact workflow columns including Done without repeating a provider heading',()=>{
  const f=fixture(),tree=f.render();for(const group of ['todo','inProgress','done'])assert.ok(findElement(tree,ID+'-column-'+group));assert.ok(findElement(tree,ID+'-columns'));assert.equal(ids(tree).filter(id=>id.startsWith(ID+'-issue-')&&!id.endsWith('-key')&&!id.endsWith('-title')&&!id.endsWith('-options')&&!id.includes('-start-')).length,3);
  assert.ok(findElement(tree,ID+'-columns').calls.some(c=>c.method==='items_start'));for(const group of ['todo','inProgress','done'])assert.ok(findElement(tree,ID+'-column-'+group).calls.some(c=>c.method==='h_full'),'Each workflow column fills the viewport for scrolling with its header at the top');
  for(const row of f.rows){const card=findElement(tree,issueCardId(ID,row));assert.ok(card.calls.some(c=>c.method==='max_w'&&c.args[0]===360));assert.equal(card.handlers.on_click,undefined);const title=findElement(tree,issueCardId(ID,row)+'-title');assert.ok(title.calls.some(c=>c.method==='h'&&c.args[0]===36));assert.ok(title.calls.some(c=>c.method==='line_height'&&c.args[0]==='18px'),'Two visible title lines need an explicit pixel height, not the native numeric multiplier');}
  assert.ok(strings(tree).includes('Done'));assert.ok(!strings(tree).includes('Jira'));assert.ok(!strings(tree).includes('Actions'));assert.ok(strings(tree).some(v=>v.includes('3 loaded')));
});

test('three pinned installed tool icons stay visible; names are limited to tooltips and accessibility labels',()=>{
  const f=fixture(),tree=f.render(),card=issueCardId(ID,f.rows[0]);
  for(const key of ['claude','codex','grok']){const button=findElement(tree,card+'-start-'+key);assert.ok(nodes(button).some(node=>node.kind===(key==='claude'?'svg':'image')&&node.value==='icons/'+key+'.svg'));}
  assert.throws(()=>findElement(tree,card+'-start-kiro'),/found 0/);assert.ok(!strings(tree).includes('Claude Code'));assert.ok(!strings(tree).includes('Codex'));
  f.props.preferences={pins:['kiro','codex'],hidden:['claude']};const custom=f.render();assert.ok(findElement(custom,card+'-start-kiro'));assert.throws(()=>findElement(custom,card+'-start-claude'),/found 0/);assert.throws(()=>findElement(custom,card+'-start-grok'),/found 0/);
  f.props.toolsForMachine=()=>[program('codex'),{...program('kiro'),installed:false}];const installed=f.render();assert.ok(findElement(installed,card+'-start-codex'));assert.throws(()=>findElement(installed,card+'-start-kiro'),/found 0/);
});

test('launch, issue links and options are independent actions and stop propagation',async()=>{
  const f=fixture(),tree=f.render(),card=issueCardId(ID,f.rows[0]);trigger(tree,card+'-start-claude',undefined,{},f.cx);assert.deepEqual(f.events.map(e=>e[0]),['launch']);assert.equal(f.events[0][2],'claude');assert.equal(f.events[0][1].identity.id,'10142');assert.equal(f.stopped(),1);
  for(const suffix of ['key','title','options']){const before=f.stopped();trigger(tree,card+'-'+suffix,undefined,{},f.cx);assert.ok(f.stopped()>before,'each action must stop its own propagation');}assert.deepEqual(f.events.map(e=>e[0]),['launch','open','open','options']);assert.ok(f.events.slice(1).every(e=>e[1].repoBinding.repoRoot==='/repos/client-portal'));
  let release;const gate=new Promise(resolve=>release=resolve);let captured;f.props.onLaunch=async(row,key)=>{await gate;captured={row,key};};const pending=trigger(f.render(),card+'-start-codex',undefined,{},f.cx);f.rows[0].repoBinding.repoRoot='/repos/changed-later';f.rows[0].identity.id='changed-later';release();await pending;assert.equal(captured.row.repoBinding.repoRoot,'/repos/client-portal');assert.equal(captured.row.identity.id,'10142');assert.equal(captured.key,'codex');
});

test('invalid or subsequently changed issue links cannot open, launch or invoke options',()=>{
  for(const url of ['javascript:alert(1)','https://other.atlassian.net/browse/WEB-142','https://work.atlassian.net/browse/WEB-999']){const row=issue(142,'todo',{url}),f=fixture({view:{state:'ready',all:false,data:[row],bindings:[],errors:[],loading:0,truncated:false}}),tree=f.render(),card=issueCardId(ID,row);for(const suffix of ['key','title','start-claude','options'])assert.throws(()=>trigger(tree,card+'-'+suffix),/Missing/);assert.equal(f.events.length,0);assert.ok(strings(tree).includes('Issue unavailable'));}
  const f=fixture(),tree=f.render(),card=issueCardId(ID,f.rows[0]);f.rows[0].identity.connectionId='not-the-bound-profile';trigger(tree,card+'-key');assert.deepEqual(f.events.map(e=>e[0]),['invalid']);
});

test('text and status filters compose independently and never alter source workflow status',()=>{
  const f=fixture(),original=f.rows.map(v=>v.statusGroup),search=f.state.search;search.set_value('WEB-144');search.listeners[0].fn({},f.cx);trigger(f.render(),ID+'-filter-done',undefined,{},f.cx);const tree=f.render();assert.equal(f.state.status,'done');assert.equal(f.state.query,'WEB-144');assert.ok(findElement(tree,issueCardId(ID,f.rows[2])));assert.throws(()=>findElement(tree,ID+'-column-todo'),/found 0/);assert.ok(strings(tree).some(v=>v.startsWith('1 / 3 loaded')));assert.deepEqual(f.rows.map(v=>v.statusGroup),original);
  trigger(tree,ID+'-filter-todo',undefined,{},f.cx);assert.ok(strings(f.render()).includes('No matching issues'));trigger(f.render(),ID+'-filter-all',undefined,{},f.cx);assert.ok(findElement(f.render(),ID+'-column-done'));assert.equal(f.state.search,search);assert.throws(()=>f.state.selectStatus('agent-working',f.cx),e=>e.code==='INVALID_FILTER');
  search.set_value('x'.repeat(600));search.listeners[0].fn({},f.cx);assert.equal(f.state.query.length,512);assert.equal(search.value().length,512);f.state.close();f.state.close();
});

test('narrow layouts stack groups, wrap filters and retain every control without fixed wide cards',()=>{
  const f=fixture({width:220}),tree=f.render();assert.ok(findElement(tree,ID+'-stacked'));assert.ok(findElement(tree,ID+'-filters-wrapped'));for(const group of ['todo','inProgress','done']){const column=findElement(tree,ID+'-column-'+group);assert.ok(column.calls.some(c=>c.method==='min_w'&&c.args[0]===0));}
  for(const id of ['scope-this','scope-all','refresh','settings','search','filter-all','filter-todo','filter-inProgress','filter-done'])assert.ok(findElement(tree,ID+'-'+id));
  delete f.props.width;trigger(f.render(),ID,'on_size_change',{width:1080,height:700},f.cx);assert.ok(findElement(f.render(),ID+'-columns'));assert.equal(f.state.width,1080);
});

test('empty, loading and unavailable groups are explicit; retained data shows its cached timestamp',()=>{
  const f=fixture();f.props.view={...f.props.view,data:[],bindings:[],loading:0};let tree=f.render();assert.ok(strings(tree).includes('No done issues'));assert.ok(strings(tree).some(v=>v.startsWith('0 loaded')));
  f.props.view={...f.props.view,state:'loading',loading:1};tree=f.render();assert.ok(strings(tree).includes('Loading issues…'));assert.ok(!strings(tree).some(v=>v.startsWith('0 loaded')));
  f.props.view={...f.props.view,state:'error',loading:0,errors:[{binding:{machine:'server',repoRoot:'/srv/unavailable'},error:{code:'AUTH_REQUIRED',message:'Check this account.'}}]};tree=f.render();assert.ok(strings(tree).includes('Unavailable'));assert.ok(strings(tree).includes('Source unavailable'));trigger(tree,ID+'-error-settings');assert.equal(f.events.at(-1)[1].repoRoot,'/srv/unavailable');
  f.props.view={...f.props.view,state:'partial',data:[issue()],bindings:[{snapshot:{fetchedAt:NOW-120000}}]};assert.ok(strings(f.render()).some(v=>v.includes('Cached · Updated 2m ago')));
});

test('All spaces keeps same-key issues distinct and selects installed shortcuts on each captured machine',()=>{
  const local=issue(),remote=issue(142,'todo',{identity:{kind:'jira',connectionId:'personal',site:'https://personal.atlassian.net',id:'10142'},url:'https://personal.atlassian.net/browse/WEB-142',repoBinding:{machine:'server',repoRoot:'/srv/client-portal',jira:{connectionId:'personal',project:'WEB'}}}),lookups=[];
  const f=fixture({view:{state:'ready',all:true,data:[local,remote],bindings:[],errors:[],loading:0,truncated:false},toolsForMachine:machine=>{lookups.push(machine);return (machine?['grok']:['claude']).map(program);}}),tree=f.render(),a=issueCardId(ID,local),b=issueCardId(ID,remote);assert.notEqual(a,b);assert.deepEqual(lookups,[null,'server']);assert.ok(findElement(tree,a+'-start-claude'));assert.ok(findElement(tree,b+'-start-grok'));assert.throws(()=>findElement(tree,b+'-start-claude'),/found 0/);trigger(tree,b+'-start-grok');assert.equal(f.events.at(-1)[1].repoBinding.machine,'server');assert.equal(f.events.at(-1)[1].identity.connectionId,'personal');assert.ok(strings(tree).includes('client-portal · server'));
});

test('scope, refresh, setup and load-more actions use compact icons and honest availability',()=>{
  const f=fixture();f.props.view.truncated=true;f.props.view.bindings[0].snapshot.cursor='opaque';let tree=f.render();trigger(tree,ID+'-scope-all');trigger(tree,ID+'-scope-this');trigger(tree,ID+'-refresh');trigger(tree,ID+'-settings');trigger(tree,ID+'-load-more');assert.deepEqual(f.events.map(e=>e[0]),['scope','scope','refresh','setup','more']);assert.deepEqual(f.events.slice(0,2),[['scope',true],['scope',false]]);assert.ok(nodes(findElement(tree,ID+'-settings')).some(node=>node.kind==='svg'&&node.value==='mods/'+MOD+'/assets/settings.svg'));
  f.props.view.loading=1;assert.throws(()=>trigger(f.render(),ID+'-refresh'),/Missing/);f.props.view.limitReached=true;assert.throws(()=>findElement(f.render(),ID+'-load-more'),/found 0/);assert.ok(strings(f.render()).includes('Select a space to see more'));
  f.props.view={state:'setup',data:[],bindings:[],errors:[],loading:0,truncated:false};tree=f.render();assert.ok(strings(tree).includes('Connect this space to its project.'));trigger(tree,ID+'-connect-action');assert.equal(f.events.at(-1)[0],'setup');
});

test('an offline execution host keeps issue browsing available while launch controls remain disabled',()=>{
  const f=fixture({launchReason:()=> 'The execution host is offline.'}),tree=f.render(),card=issueCardId(ID,f.rows[0]);for(const suffix of ['start-claude','start-codex','start-grok','options'])assert.throws(()=>trigger(tree,card+'-'+suffix),/Missing/);trigger(tree,card+'-key');assert.deepEqual(f.events.map(e=>e[0]),['open']);
});

test('the same board validates direct GitHub issue URLs without adding Jira labels or mixed PR content',()=>{
  const row={...issue(38,'done'),identity:{kind:'github',connectionId:'gh-work',site:'https://github.com',id:'github-node-38'},key:'GH-38',url:'https://github.com/Acme/Web/issues/38',statusName:'Closed',repoBinding:{machine:null,repoRoot:'/repos/web',github:{connectionId:'gh-work',owner:'Acme',repo:'Web'}}},f=fixture({mod:'mission-control-github',view:{state:'ready',all:false,data:[row],bindings:[],errors:[],loading:0,truncated:false}}),tree=f.render();trigger(tree,issueCardId(ID,row)+'-key');assert.equal(f.events[0][1].identity.kind,'github');assert.equal(f.events[0][1].url,row.url);assert.ok(!strings(tree).includes('Jira'));
});
