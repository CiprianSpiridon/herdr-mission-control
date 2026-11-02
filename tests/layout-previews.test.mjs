import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {bundleLayouts} from '../scripts/project.mjs';
const names=['mission-control','mission-control-classic'];
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-layout-preview-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const mod='mission-control-preview-fixture';await fs.mkdir(path.join(root,'src/mods',mod),{recursive:true});await fs.mkdir(path.join(root,'src/shared'));await fs.mkdir(path.join(root,'src/layouts'));await fs.writeFile(path.join(root,'src/mods',mod,'main.js'),'import {View,div} from "gpui-kit";export default class Preview extends View{render(){return div();}}');await fs.writeFile(path.join(root,'src/mods',mod,'mod.json'),'{"title":"Preview fixture","place":"none"}');for(const name of names){await fs.writeFile(path.join(root,'src/layouts',name+'.json'),JSON.stringify({type:'block',preview:'layouts/'+name+'.svg',content:{mod}}));await fs.copyFile(new URL('../src/layouts/'+name+'.svg',import.meta.url),path.join(root,'src/layouts',name+'.svg'));}return root;}
test('both owned Settings previews are valid XML and copy byte-for-byte through a fixture bundle',async t=>{
 const overview=await fs.readFile(new URL('../src/layouts/mission-control.svg',import.meta.url),'utf8');assert.deepEqual([...overview.matchAll(/data-source="([a-z]+)"/g)].map(match=>match[1]),['jira','github','pulls','gitlab','merges','sessions'],'Settings overview depicts every distinct planned work source');
 const root=await fixture(t);for(const name of names){const r=spawnSync('python3',['-c','import sys,xml.etree.ElementTree as E;r=E.parse(sys.argv[1]).getroot();assert r.tag=="{http://www.w3.org/2000/svg}svg";assert r.attrib["viewBox"]=="0 0 480 300";assert r.attrib["data-view"]==sys.argv[2]',path.join(root,'src/layouts',name+'.svg'),name],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 const bundle=await bundleLayouts({root});for(const name of names)assert.deepEqual(await fs.readFile(path.join(bundle.directory,'layouts',name+'.svg')),await fs.readFile(new URL('../src/layouts/'+name+'.svg',import.meta.url)));
});
test('malformed, outside-path and missing SVGs fail without replacing the previous fixture bundle',async t=>{
 const root=await fixture(t),good=await bundleLayouts({root}),source=path.join(root,'src/layouts/mission-control.svg'),output=path.join(good.directory,'layouts/mission-control.svg'),before=await fs.readFile(output);
 await fs.writeFile(source,'<svg xmlns="http://www.w3.org/2000/svg"><g></svg>');await assert.rejects(bundleLayouts({root}),/Malformed layout SVG/);assert.deepEqual(await fs.readFile(output),before);
 const outside=path.join(root,'outside.svg');await fs.writeFile(outside,'<svg xmlns="http://www.w3.org/2000/svg"></svg>');await fs.rm(source);await fs.symlink(outside,source);await assert.rejects(bundleLayouts({root}),/escapes/);
 await fs.rm(source);await assert.rejects(bundleLayouts({root}),/ENOENT/);assert.deepEqual(await fs.readFile(output),before);
});
