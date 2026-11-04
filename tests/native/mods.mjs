/**
 * Native gate for mission-control-mods in the private Herdr harness (never the person's Herdr).
 * Fixture: local git repositories stand in for GitHub (file:// remotes are accepted only with QA_MODS_FIXTURE=1),
 * and a local catalog file stands in for herdr.dev, so the helper never reaches the network. The private app home
 * holds three fixture mods (QA clock, QA notes, QA timer) and a fixture layout (qa-board), installed from the
 * repositories' first commit, plus the gate's own layout that shows QA clock, QA notes and the Mods panel.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {run,until} from '../../scripts/native-harness.mjs';
import {decodePng} from './layout.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
export const MOD='mission-control-mods';
export const CATALOG_DIR=path.join(ROOT,'.harness/mods-fixture');
// Fixture mode only: file:// sources and a local catalog. Values are synthetic and owned by this repository.
export const fixtureEnvironment={QA_MODS_FIXTURE:'1',QA_MODS_CATALOG_URL:'file://'+CATALOG_DIR+'/{kind}.json'};
export const KEY='cmd-shift-9';
const LEFT=360,PREVIEW_RGB=[217,70,239];

export const EXPECTATIONS=Object.freeze({
  listed:'The Mods panel lists the fixture mods and layout with their GitHub-style sources and the gate’s own layout as source unknown',
  thumbnails:'Each fixture item shows its repository’s own preview.png as a thumbnail, cached by the helper',
  updateFound:'Check for updates finds the new upstream commit of QA clock and nothing else',
  review:'Update shows the changed file and the added key before anything is written',
  applied:'Apply update writes the new files in place and the mounted QA clock hot-reloads to v2 without a restart',
  keyAdded:'The update’s new key reaches keys.json and pressing it reaches QA clock',
  updateAll:'Update all applies the safe QA timer update and leaves QA notes, whose update conflicts with an edit, for a review',
  conflict:'An update that changes a line the person edited stops with a conflict and writes nothing',
  conflictResolved:'Take theirs resolves the conflict and the update applies',
  keyRemoved:'A later update that drops the key removes it from keys.json, and pressing it no longer reaches QA clock',
  usedByActive:'Disabling a mod the layout on screen uses is refused with that layout’s name',
  confirmLayouts:'Disabling a mod another layout uses asks first, naming that layout, and moves nothing until confirmed',
  disableEnable:'Disable moves QA timer out of mods/ and Enable brings back identical files',
  uninstallRestore:'Uninstall says removed items are kept for 30 days, and Restore brings back identical files',
  activeLayout:'Uninstalling the layout on screen is refused and its file stays',
  builtIn:'Herdr’s own items are listed as built in, with no actions',
  noErrors:'The Mods panel and the fixture mods produced zero native app errors'
});

// ---------------------------------------------------------------------------------------------
// Fixture: repositories, catalog and the installed first versions.
// ---------------------------------------------------------------------------------------------
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=bytes=>{let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
/** A solid RGB PNG with a lighter band, so the thumbnail is recognisable in a native frame. */
export function png(width,height,[r,g,b]){
  const chunk=(kind,body)=>{const head=Buffer.alloc(8);head.writeUInt32BE(body.length,0);head.write(kind,4,'latin1');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind,'latin1'),body])));return Buffer.concat([head,body,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  const rows=[];for(let y=0;y<height;y++){const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){const band=y>=height*0.4&&y<height*0.6;row[1+x*3]=band?255:r;row[2+x*3]=band?255:g;row[3+x*3]=band?255:b;}rows.push(row);}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
}
const clock=(version,{commands=false}={})=>commands
  ? `import {View,div} from 'gpui-kit';\nimport * as herdr from 'herdr';\n\nexport default class QaClock extends View {\n  init(_props,cx){this.count=0;this.task=cx.spawn(async c=>{for(;;){const command=await herdr.nextCommand();if(command==='bump'){this.count++;c.notify();}}});}\n  render(){return div().size_full().p(12).text_size(15).child('QA clock ${version} bumped '+(['none','one','two','three'][this.count]||'many'));}\n}\n`
  : `import {View,div} from 'gpui-kit';\n\nexport default class QaClock extends View {\n  render(){return div().size_full().p(12).text_size(15).child('QA clock ${version}');}\n}\n`;
const notes=second=>`import {View,div} from 'gpui-kit';\n\nconst LINES=[\n  'QA notes',\n  'first note',\n  '${second}',\n  'third note'\n];\n\nexport default class QaNotes extends View {\n  render(){return div().size_full().p(12).text_size(13).child(LINES.join(' / '));}\n}\n`;
const timer=version=>`import {View,div} from 'gpui-kit';\n\nexport default class QaTimer extends View {\n  render(){return div().size_full().p(12).text_size(13).child('QA timer ${version}');}\n}\n`;
const manifest=title=>JSON.stringify({title,place:'none'},null,2)+'\n';
const BOARD={id:'qa-board-root',type:'row',children:[{id:'qa-board-timer',type:'block',size:{px:240},content:{mod:'qa-timer'}},{id:'qa-board-main',type:'block',content:{tab:'active'}}]};

/** Builds the repositories, the catalog and the installed first versions. Pure files; usable without Herdr. */
export async function buildFixture({directory,home,env=process.env,catalogDir=CATALOG_DIR}){
  const git=(cwd,...args)=>run('git',['-C',cwd,...args],{env,json:false});
  const repo=async name=>{const dir=path.join(directory,name);await fs.mkdir(dir,{recursive:true});git(dir,'init','-q','-b','main');git(dir,'config','user.name','Mission Control QA');git(dir,'config','user.email','qa@example.invalid');git(dir,'config','commit.gpgsign','false');git(dir,'config','uploadpack.allowFilter','true');return dir;};
  const put=async(root,files)=>{for(const[rel,data]of Object.entries(files)){const file=path.join(root,rel);if(data===null){await fs.rm(file,{force:true});continue;}await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);}};
  const commit=(dir,message)=>{git(dir,'add','-A');git(dir,'commit','-qm',message);return git(dir,'rev-parse','HEAD').trim();};
  const widgets=await repo('qa-widgets'),boards=await repo('qa-layouts');
  await put(widgets,{'mods/qa-clock/main.js':clock('v1'),'mods/qa-clock/mod.json':manifest('QA clock'),'mods/qa-notes/main.js':notes('second note'),'mods/qa-notes/mod.json':manifest('QA notes'),
    'mods/qa-timer/main.js':timer('v1'),'mods/qa-timer/mod.json':manifest('QA timer'),'preview.png':png(96,60,PREVIEW_RGB),'README.md':'# QA widgets\n'});
  await put(boards,{'layouts/qa-board.json':JSON.stringify(BOARD,null,2)+'\n','layouts/qa-board.svg':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300" fill="#101114"/></svg>\n','preview.png':png(96,60,PREVIEW_RGB),'README.md':'# QA layouts\n'});
  const state={widgets,boards,heads:{widgets:commit(widgets,'QA widgets v1'),boards:commit(boards,'QA board v1')}};
  const writeCatalog=async()=>{
    await fs.mkdir(catalogDir,{recursive:true});
    const entry=(dir,head,names,key)=>({owner:'fixture',repo:path.basename(dir),fullName:'fixture/'+path.basename(dir),url:'file://'+dir,defaultBranch:'main',headCommit:head,path:'',name:path.basename(dir),stars:0,pushedAt:null,[key]:names,hasKeys:true,hasPreview:true,previewUrl:'file://'+path.join(dir,'preview.png')});
    await fs.writeFile(path.join(catalogDir,'mods.json'),JSON.stringify({generatedAt:new Date().toISOString(),mods:[entry(widgets,state.heads.widgets,['qa-clock','qa-notes','qa-timer'],'modNames')]}));
    await fs.writeFile(path.join(catalogDir,'layouts.json'),JSON.stringify({generatedAt:new Date().toISOString(),layouts:[entry(boards,state.heads.boards,['qa-board.json'],'layoutFiles')]}));
    // The herdr.dev catalog refreshes hourly; the gate stands in for that hour by dropping the helper's cached copy.
    for(const kind of ['mods','layouts'])await fs.rm(path.join(home,'mission-control/mods/cache',`catalog-${kind}.json`),{force:true});
  };
  await writeCatalog();
  for(const name of ['qa-clock','qa-notes','qa-timer'])await fs.cp(path.join(widgets,'mods',name),path.join(home,'mods',name),{recursive:true});
  for(const ext of ['json','svg'])await fs.cp(path.join(boards,'layouts','qa-board.'+ext),path.join(home,'layouts','qa-board.'+ext));
  // The person's own edit of QA notes, made before the panel ever runs.
  await fs.writeFile(path.join(home,'mods/qa-notes/main.js'),notes('second note mine'));
  state.push=async(files,message)=>{await put(widgets,files);state.heads.widgets=commit(widgets,message);await writeCatalog();return state.heads.widgets;};
  return state;
}
export const UPSTREAM=Object.freeze({
  clockV2:{'mods/qa-clock/main.js':clock('v2',{commands:true}),'keys.json':JSON.stringify({global:{[KEY]:'qa-clock.bump'}},null,2)+'\n'},
  notesAndTimer:{'mods/qa-notes/main.js':notes('second note theirs'),'mods/qa-timer/main.js':timer('v2')},
  clockV3:{'mods/qa-clock/main.js':clock('v3',{commands:true}),'keys.json':null}
});

async function hashDir(dir){const out={};async function walk(d,rel){for(const e of await fs.readdir(d,{withFileTypes:true}).catch(()=>[])){const p=rel?rel+'/'+e.name:e.name;if(e.isDirectory())await walk(path.join(d,e.name),p);else out[p]=crypto.createHash('sha256').update(await fs.readFile(path.join(d,e.name))).digest('hex');}}await walk(dir,'');return out;}
const exists=file=>fs.access(file).then(()=>true,()=>false);

// ---------------------------------------------------------------------------------------------
// The native run.
// ---------------------------------------------------------------------------------------------
export default async function mods(runtime){
  const home=runtime.env.HERDR_APP_HOME,records=path.join(home,'mission-control/mods');
  const progress=stage=>fs.writeFile(path.resolve(ROOT,'.harness/mods-progress.json'),JSON.stringify({stage,nonce:runtime.nonce,assertions:runtime.assertions.length})+'\n');
  await progress('fixture');
  await fs.mkdir(path.join(home,'mods'),{recursive:true});await fs.mkdir(path.join(home,'layouts'),{recursive:true});
  const fixture=await buildFixture({directory:path.join(runtime.directory,'mods-repos'),home,env:runtime.env});
  await runtime.installPackage(MOD);
  for(const name of ['qa-clock','qa-notes','qa-timer'])runtime.app(['check',path.join(home,'mods',name)],{json:false});
  const block=(id,mod,px)=>({id,type:'block',...(px?{size:{px}}:{}),content:{mod}});
  await runtime.startWindow({name:'mods',layout:{id:'qa-root',type:'row',titlebar:'none',traffic_lights:[12,16],children:[
    // The terminal takes the top-left corner under the window buttons, so the fixture mods' text stays readable.
    {id:'qa-left',type:'column',size:{px:LEFT},children:[{id:'qa-main',type:'block',content:{tab:'active'}},block('qa-clock-block','qa-clock',70),block('qa-notes-block','qa-notes',70)]},
    block('qa-mods',MOD)]}});
  const ACTIVE='mission-control-mods';
  let serial=0;const renderFailures=[];
  // macOS now and then refuses one window capture while the window stays on screen; retry that alone.
  // A window briefly off screen (another desktop shown) reads as no visible window: wait up to a minute for it.
  const capture=async label=>{for(let attempt=1;;attempt++){try{return await runtime.frame(label);}catch(error){if(attempt>=40||!/could not be captured|create image|visible native window/i.test(error.message))throw error;await new Promise(r=>setTimeout(r,1500));}}};
  const observe=async(query='')=>{if(++serial>260)throw Error('Native observation budget exhausted');const frame=await capture('mods-observe-'+serial),o=await runtime.driver.ocr(path.resolve(ROOT,frame.path),query);
    for(const line of o.lines)if(/could not be re.?rendered/i.test(line.text))renderFailures.push(line.text);return o;};
  const inPanel=n=>n.frame.x>=LEFT;const inLeft=n=>n.frame.x<LEFT;
  const sees=async(text,where=inPanel)=>{const o=await observe(text);return o.matches.some(n=>n.confidence>=0.5&&where(n));};
  const waitSee=(text,where=inPanel,timeout=60000)=>until(()=>sees(text,where),'visible '+text,timeout);
  const packages=async()=>{try{return JSON.parse(await fs.readFile(path.join(records,'packages.json'),'utf8'));}catch{return {packages:{}};}};
  const keys=async()=>JSON.parse(await fs.readFile(path.join(home,'keys.json'),'utf8'));
  // GPUI controls are not in the accessibility tree: click visible text (scoped to its item's row) like every other gate.
  // OCR reads an ellipsis as "…", "..." or "..": compare without trailing dots.
  const norm=text=>text.trim().replace(/[\s.…]+$/,'').trim().toLowerCase();
  const activate=async(label,{text=label,row=null,timeout=45000}={})=>{
    const found=await until(async()=>{
      // OCR matches carry only the searched words; whole lines tell "Update…" from "Update available".
      const o=await observe(text.replace(/…$/,''));let matches=o.lines.filter(n=>(n.confidence??1)>=0.5&&inPanel(n)&&norm(n.text)===norm(text));
      // Any line holding the row text anchors the control on the same row (a status line may repeat the text).
      if(row){const anchors=o.lines.filter(n=>inPanel(n)&&n.text.includes(row)&&!matches.includes(n));matches=matches.filter(m=>anchors.some(a=>Math.abs(m.frame.y+m.frame.height/2-(a.frame.y+a.frame.height/2))<16));}
      return matches.length===1?{observation:o,node:matches[0]}:null;
    },'native control '+label,timeout);
    // Click the observed match that lies inside the chosen line (the driver accepts only observed matches).
    const line=found.node.frame,inside=found.observation.matches.filter(m=>m.confidence>=0.6&&m.frame.x+m.frame.width/2>=line.x&&m.frame.x+m.frame.width/2<=line.x+line.width&&m.frame.y+m.frame.height/2>=line.y&&m.frame.y+m.frame.height/2<=line.y+line.height);
    if(inside.length===1)await runtime.driver.clickObservedText(found.observation,inside[0]);
    else await runtime.driver.click(line,{expectedSize:found.observation.window});
    Object.assign(runtime.driver.actions.at(-1),{control:label,observation:found.observation.source});
  };
  // The refresh button is icon-only: it sits at the right end of the search row, 25 px from the window edge.
  const check=async()=>{
    const {observation,field}=await until(async()=>{const o=await observe('Search mods and layouts'),f=o.matches.find(n=>n.confidence>=0.5&&inPanel(n));return f?{observation:o,field:f}:null;},'Mods toolbar',45000);
    const y=field.frame.y+field.frame.height/2;
    await runtime.driver.click({x:observation.window.width-39,y:y-14,width:28,height:28},{expectedSize:observation.window});
    Object.assign(runtime.driver.actions.at(-1),{control:'Check for updates',observation:observation.source});
  };
  const updateFor=async(key,commit)=>until(async()=>{const r=(await packages()).packages[key];return r?.lastResult?.state==='update'&&r.lastResult.update?.commit===commit?r:null;},'helper sees the update of '+key,90000);

  try{
    // 1. Listing, adoption and thumbnails.
    await progress('listing');
    await waitSee('QA clock v1',inLeft);
    await until(async()=>{const p=(await packages()).packages;return ['mod:qa-clock','mod:qa-notes','mod:qa-timer','layout:qa-board'].every(k=>['current','edited'].includes(p[k]?.state))&&p['mod:qa-notes'].state==='edited'?p:null;},'helper adopted every fixture item',120000);
    await waitSee('fixture/qa-widgets');
    runtime.expect(await sees('QA timer')&&await sees('qa-board')&&await sees('Edited by you')&&await sees('Source unknown'),EXPECTATIONS.listed);
    await until(async()=>(await Promise.all(['mod-qa-clock','mod-qa-notes','mod-qa-timer','layout-qa-board'].map(n=>exists(path.join(records,'cache/previews',n+'.png'))))).every(Boolean),'helper cached the preview images',90000);
    await check();
    const thumbs=await until(async()=>{const o=await observe(),image=decodePng(await fs.readFile(path.resolve(ROOT,o.source.path))),scale=image.width/o.window.width;let hits=0;
      for(let y=0;y<image.height;y++)for(let x=Math.floor(LEFT*scale);x<image.width;x++){const [r,g,b]=image.pixel(x,y);if(Math.abs(r-PREVIEW_RGB[0])<24&&Math.abs(g-PREVIEW_RGB[1])<24&&Math.abs(b-PREVIEW_RGB[2])<24)hits++;}
      return hits>600?hits:null;},'repository previews drawn as thumbnails',60000);
    runtime.expect(Boolean(thumbs),EXPECTATIONS.thumbnails);

    // 2. An update with a new key: check, review, apply, hot reload, key.
    await progress('update');
    const v2=await fixture.push(UPSTREAM.clockV2,'QA clock v2 with a bump key');
    await check();await updateFor('mod:qa-clock',v2);
    const p2=(await packages()).packages;
    await waitSee('Update all (1)');
    runtime.expect(['mod:qa-notes','mod:qa-timer','layout:qa-board'].every(k=>p2[k]?.lastResult?.state!=='update')&&await sees('Update available'),EXPECTATIONS.updateFound);
    await activate('Update QA clock',{text:'Update…',row:'QA clock'});
    await waitSee('Apply update');
    runtime.expect(await sees('Changed or added')&&await sees('main.js')&&await sees(KEY)&&(await fs.readFile(path.join(home,'mods/qa-clock/main.js'),'utf8'))===clock('v1'),EXPECTATIONS.review);
    await activate('Apply update');
    await until(async()=>(await fs.readFile(path.join(home,'mods/qa-clock/main.js'),'utf8'))===clock('v2',{commands:true}),'QA clock v2 written',60000);
    await waitSee('QA clock v2 bumped none',inLeft,60000);
    runtime.expect((await packages()).packages['mod:qa-clock'].commit===v2&&await sees('QA clock v2 bumped none',inLeft),EXPECTATIONS.applied);
    await until(async()=>(await keys()).global?.[KEY]==='qa-clock.bump','key merged into keys.json',30000);
    await runtime.driver.press(KEY);
    runtime.expect(Boolean(await until(()=>sees('QA clock v2 bumped one',inLeft),'QA clock received the new key',30000)),EXPECTATIONS.keyAdded);

    // 3. Update all: a safe update applies, a conflicting one waits for a review.
    await progress('update-all');
    const notesBefore=await fs.readFile(path.join(home,'mods/qa-notes/main.js'),'utf8');
    const v3=await fixture.push(UPSTREAM.notesAndTimer,'QA notes and QA timer v2');
    await check();await updateFor('mod:qa-timer',v3);await updateFor('mod:qa-notes',v3);
    await activate('Update all (2)',{text:'Update all (2)',timeout:60000});
    await until(async()=>(await fs.readFile(path.join(home,'mods/qa-timer/main.js'),'utf8'))===timer('v2'),'QA timer v2 applied by Update all',90000);
    await waitSee('needs a review');
    runtime.expect((await fs.readFile(path.join(home,'mods/qa-notes/main.js'),'utf8'))===notesBefore,EXPECTATIONS.updateAll);

    // 4. The conflict: nothing written, then Take theirs.
    await progress('conflict');
    await activate('Update QA notes',{text:'Update…',row:'QA notes'});
    await waitSee('Nothing was written');
    runtime.expect((await fs.readFile(path.join(home,'mods/qa-notes/main.js'),'utf8'))===notesBefore&&await exists(path.join(records,'conflicts/mod-qa-notes/main.js')),EXPECTATIONS.conflict);
    await activate('Take theirs');await waitSee('Apply update');await activate('Apply update');
    await until(async()=>(await fs.readFile(path.join(home,'mods/qa-notes/main.js'),'utf8'))===notes('second note theirs'),'QA notes takes theirs',60000);
    runtime.expect(Boolean(await until(()=>sees('second note theirs',inLeft),'QA notes hot-reloaded',60000)),EXPECTATIONS.conflictResolved);

    // 5. An update that drops the key.
    await progress('key-removed');
    const v4=await fixture.push(UPSTREAM.clockV3,'QA clock v3 without the key');
    await check();await updateFor('mod:qa-clock',v4);
    await activate('Update QA clock',{text:'Update…',row:'QA clock'});await waitSee('Keys removed');await activate('Apply update');
    await until(async()=>(await keys()).global?.[KEY]===undefined,'key removed from keys.json',60000);
    await waitSee('QA clock v3 bumped none',inLeft,60000);
    await runtime.driver.press(KEY);await new Promise(r=>setTimeout(r,1500));
    runtime.expect(await sees('QA clock v3 bumped none',inLeft)&&!(await sees('QA clock v3 bumped one',inLeft)),EXPECTATIONS.keyRemoved);

    // 6. Refusals and confirmations.
    await progress('lifecycle');
    await activate('Disable QA clock',{text:'Disable',row:'QA clock'});
    await waitSee('used by the layout on screen');
    runtime.expect(await sees(ACTIVE)&&await exists(path.join(home,'mods/qa-clock/main.js')),EXPECTATIONS.usedByActive);
    const timerFiles=await hashDir(path.join(home,'mods/qa-timer'));
    await activate('Disable QA timer',{text:'Disable',row:'QA timer'});
    await waitSee('Used by qa-board');
    runtime.expect(await exists(path.join(home,'mods/qa-timer/main.js')),EXPECTATIONS.confirmLayouts);
    await activate('Confirm: disable QA timer',{text:'Disable',row:'Used by qa-board'});
    await until(async()=>!(await exists(path.join(home,'mods/qa-timer')))&&await exists(path.join(records,'disabled/mods/qa-timer/main.js')),'QA timer disabled',60000);
    await waitSee('Disabled');
    await activate('Enable QA timer',{text:'Enable',row:'QA timer'});
    await until(()=>exists(path.join(home,'mods/qa-timer/main.js')),'QA timer enabled',60000);
    // The files move first; wait for the panel to list QA timer as enabled again before clicking its row.
    await until(async()=>!(await sees('Enable')),'panel lists QA timer enabled',60000);
    runtime.expect(JSON.stringify(await hashDir(path.join(home,'mods/qa-timer')))===JSON.stringify(timerFiles),EXPECTATIONS.disableEnable);
    await activate('Uninstall QA timer',{text:'Uninstall',row:'QA timer'});
    await waitSee('restored for 30 days');
    await activate('Confirm: remove QA timer',{text:'Remove',row:'then it is deleted'});
    await until(async()=>!(await exists(path.join(home,'mods/qa-timer'))),'QA timer removed',60000);
    await waitSee('Removed (restorable for 30 days)');
    await activate('Restore qa-timer',{text:'Restore',row:'timer (mod)'});
    await until(()=>exists(path.join(home,'mods/qa-timer/main.js')),'QA timer restored',60000);
    await until(async()=>!(await sees('Removed (restorable')),'panel lists QA timer restored',60000);
    runtime.expect(JSON.stringify(await hashDir(path.join(home,'mods/qa-timer')))===JSON.stringify(timerFiles),EXPECTATIONS.uninstallRestore);
    await activate('Uninstall '+ACTIVE,{text:'Uninstall',row:ACTIVE});
    await activate('Confirm: remove '+ACTIVE,{text:'Remove',row:'then it is deleted'});
    await waitSee('switch to another layout first');
    runtime.expect(await exists(path.join(home,'layouts',ACTIVE+'.json'))&&runtime.app(['status']).layout===ACTIVE,EXPECTATIONS.activeLayout);

    // 7. Built-in items are read-only.
    await progress('built-in');
    await activate('Built in',{text:'Built in'});
    await waitSee('Built into Herdr');
    // The Built in filter shows only Herdr's own items, expanded: each reads Built into Herdr and none has an action.
    const builtIn=await until(async()=>{const o=await observe(),rows=o.lines.filter(l=>inPanel(l)&&l.text.trim()==='Built into Herdr');return rows.length>=3?o:null;},'built-in rows listed',45000);
    // Only the row buttons count: the "Updates" filter chip is not an action.
    runtime.expect(!builtIn.lines.some(l=>inPanel(l)&&['disable','enable','uninstall','update','link source','choose source'].includes(norm(l.text))),EXPECTATIONS.builtIn);
    await activate('All',{text:'All'});await waitSee('QA timer');
    const preview=await capture('mods-preview');await fs.copyFile(path.resolve(ROOT,preview.path),path.resolve(ROOT,'.harness/mods-preview-candidate.png'));
    runtime.expect(runtime.app(['status']).errors.length===0&&renderFailures.length===0,EXPECTATIONS.noErrors);
    await progress('passed');
  }catch(error){
    try{await runtime.frame('mods-failure');const directory=path.resolve(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.writeFile(path.join(directory,'native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));}catch{}
    throw error;
  }
}
