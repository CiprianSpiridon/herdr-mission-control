import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {iconButton,toolIcon,metric,safeArtworkPath,createSearch} from '../src/shared/ui.js';
import {injectNative,trigger,context} from './support/native-recording.mjs';
test('icon-only controls invoke the actual handler and disabled controls cannot act',()=>{
  injectNative();let clicks=0;const el=iconButton('mission-control','switch','layout','Switch view',()=>clicks++);
  trigger(el,'switch');assert.equal(clicks,1);assert.equal(el.nodes[0].value,'mods/mission-control/assets/layout.svg');
  assert.throws(()=>trigger(iconButton('mission-control','off','plus','Disabled',()=>clicks++,{disabled:true}),'off'),/Missing/);
});
test('tool artwork respects native tint metadata and rejects remote/escaping paths',()=>{
  injectNative();assert.equal(toolIcon('mission-control',{icon:'icons/codex.svg',tint:false,name:'Codex'}).nodes[0].kind,'image');
  assert.equal(toolIcon('mission-control',{icon:'icons/claude.svg',tint:true,name:'Claude'}).nodes[0].kind,'svg');
  for(const p of ['https://a/icon.svg','mods/../secret','icons//bad','icons/./bad'])assert.equal(safeArtworkPath(p),null);
  assert.match(toolIcon('mission-control',{icon:'https://a'}).nodes[0].value,/assets\/agent.svg$/);
});
test('metrics never turn unavailable values into zero or a guessed percentage',()=>{
  assert.equal(metric('Context left',{}).nodes[1].nodes[0],'Unavailable');
  assert.equal(metric('Quota left',{state:'available',percent:32}).nodes[1].nodes[0],'32%');
  assert.equal(metric('Quota left',{state:'available',percent:132}).nodes[1].nodes[0],'Unavailable');
});
test('search uses retained InputState change events',()=>{
  let result;const state=createSearch('Find spaces',(value)=>result=value);state.set_value('client');state.listeners[0].fn({},context());assert.equal(result,'client');
});
test('all local artwork is self-contained SVG with provenance and clean UTF-8',async()=>{
  const catalog=JSON.parse(await fs.readFile(new URL('../src/assets/icons.json',import.meta.url),'utf8'));
  for(const name of ['jira','github','pull-request','sessions','agent','layout','more','settings','plus','search','chevron-down','chevron-right'])assert.ok(catalog[name]);
  for(const [name,asset] of Object.entries(catalog)){assert.match(asset.svg,/^<svg[ >]/,name);assert.match(asset.svg,/<\/svg>$/);assert.ok(asset.source&&asset.license);assert.doesNotMatch(asset.svg,/<script|href=|Ã|Â|â‹/);}
});
