import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateNativeIsolationReceipt} from './native-harness.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
/** The five standalone packages built before the GitLab shared extensions, in their original gate order. */
export const PACKAGES=Object.freeze(['agent-menu','spaces','agents','jira','github'].map(scenario=>Object.freeze({name:'mission-control-'+scenario,scenario})));
const read=async file=>{try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};

/** A historical success never covers changed runtime bytes: every receipt, manifest, artifact, source and preview must agree now. */
export async function reconcilePackage({name,scenario},{root=ROOT,validate=validateNativeIsolationReceipt}={}){
  const reasons=[],receiptPath=path.join(root,'evidence/native',scenario+'.json'),raw=await read(receiptPath);let receipt=null;
  if(!raw)return {name,scenario,ok:false,reasons:['MISSING_RECEIPT']};
  try{receipt=JSON.parse(raw);}catch{return {name,scenario,ok:false,reasons:['INVALID_RECEIPT']};}
  if(receipt?.ok!==true)reasons.push('FAILED_RECEIPT');else try{if(await validate(receipt,{receiptPath})!==true)reasons.push('UNPROVEN_ISOLATION');}catch{reasons.push('UNPROVEN_ISOLATION');}
  const manifestRaw=await read(path.join(root,name,'build-manifest.json'));let manifest=null;try{manifest=manifestRaw&&JSON.parse(manifestRaw);}catch{}
  if(!manifest?.artifacts||!manifest?.sources)reasons.push('MISSING_MANIFEST');
  else{
    const tested=receipt?.packages?.find?.(p=>p.name===name);if(!tested?.nativeCheck||!isDeepStrictEqual(tested.manifest,manifest))reasons.push('STALE_MANIFEST');
    for(const[file,expected]of Object.entries(manifest.artifacts)){const bytes=await read(path.join(root,name,'mods',name,file));if(!bytes||sha(bytes)!==expected){reasons.push('ARTIFACT_MISMATCH');break;}}
    for(const[file,expected]of Object.entries(manifest.sources)){const bytes=await read(path.join(root,file));if(!bytes||sha(bytes)!==expected){reasons.push('SOURCE_MISMATCH');break;}}
  }
  const frame=receipt?.frames?.find?.(f=>f.label===scenario+'-preview'),preview=await read(path.join(root,name,'preview.png'));
  if(!frame||!preview||sha(preview)!==frame.sha256)reasons.push('PREVIEW_MISMATCH');
  return {name,scenario,ok:!reasons.length,reasons,...(receipt?.completedMs?{receiptCompletedMs:receipt.completedMs}:{}),...(frame?{previewSha256:frame.sha256}:{})};
}

const step=(command,args)=>{const started=Date.now(),p=spawnSync(command,args,{cwd:ROOT,encoding:'utf8',maxBuffer:64*1024*1024,timeout:20*60*1000});return {command:[command,...args].join(' '),exitCode:p.status??1,durationMs:Date.now()-started};};

/** Rebuild and re-prove each earlier package sequentially with the current isolated harness, then reconcile. */
export async function verifyCompatibility({root=ROOT,run=true}={}){
  const results=[];
  for(const pkg of PACKAGES){
    const steps=[];
    if(run){steps.push(step(process.execPath,['scripts/native-harness.mjs','run',pkg.scenario]));steps.push(step(process.execPath,['--import','./tests/support/native-loader.mjs','--test','--test-concurrency=1',`tests/package-${pkg.scenario}.test.mjs`]));}
    const reconciled=await reconcilePackage(pkg,{root});if(steps.some(s=>s.exitCode!==0))reconciled.reasons.unshift('GATE_FAILED');
    results.push({...reconciled,ok:reconciled.ok&&steps.every(s=>s.exitCode===0),steps});
  }
  return {v:1,kind:'gitlab-shared-extension-compatibility',ok:results.every(r=>r.ok),completedMs:Date.now(),packages:results,boundary:'Fixture-only native and copied-mod package gates at current source/artifact hashes. No provider calls, user-home install or historical receipt reuse.'};
}

async function main(args){
  const receipt=await verifyCompatibility({run:!args.includes('--reconcile-only')});
  await fs.mkdir(path.join(ROOT,'evidence/native'),{recursive:true});await fs.writeFile(path.join(ROOT,'evidence/native/gitlab-compatibility.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt.packages.map(p=>({name:p.name,ok:p.ok,reasons:p.reasons})),null,2));if(!receipt.ok)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
