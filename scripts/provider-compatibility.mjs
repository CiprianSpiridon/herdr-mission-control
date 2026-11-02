import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readConfig} from '../src/shared/config.js';
import {defaultUsageSources,validateUsageSource} from '../src/shared/usage-sources.js';
import {validateProviderObservation} from '../src/shared/provider-observation.js';
import {BindingStore} from '../src/shared/session-bindings.js';
import {sessionKey,terminalIdentity,terminalKey} from '../src/shared/session-identity.js';
import {normalizeContext} from '../src/shared/context.js';
import {normalizeQuota} from '../src/shared/quota.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),liveReceipts=new WeakSet(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const SOURCE_HASH=sha(await fs.readFile(fileURLToPath(import.meta.url))),VERSION=/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/;
const read=async file=>{try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const execute=(command,args)=>{const p=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:1048576});return {code:p.status??1,stdout:p.stdout||'',stderr:p.stderr||''};};
const safeVersion=result=>result.code===0?result.stdout.match(VERSION)?.[0]||'unverified':'unavailable';

/** Optional injected environment is always fixture evidence, even with real files. */
export async function probeInstalledProviders(options){
  const live=options===undefined,settings=options||{},home=settings.home||os.homedir(),appHome=settings.appHome||process.env.HERDR_APP_HOME||path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'herdr-app'),exec=settings.exec||execute,now=Date.now();
  const sourceNames=['collector.py','provider_codex.py','provider_claude.py','provider_grok.py'],chunks=await Promise.all(sourceNames.map(name=>fs.readFile(path.join(ROOT,'src/shared',name),'utf8'))),code=chunks.join('\n\n')+'\n\nif __name__ == "__main__":\n    collector_main({"codex": collect_codex, "claude": collect_claude, "grok": collect_grok})\n';
  const io={appHome:()=>appHome,readTextFile:read},receipt={v:1,kind:'installed-provider-compatibility',evidenceKind:live?'live-installed-metadata':'synthetic-or-injected-environment',generatedAt:new Date(now).toISOString(),probeSourceSha256:SOURCE_HASH,collectorSourceSha256:sha(code),collectorBytes:Buffer.byteLength(code),platform:process.platform,pythonVersion:'unavailable',bindingStoreStatus:'unread',providers:[],status:'UNVERIFIED'};
  receipt.helperSourceSha256=Object.fromEntries(await Promise.all(['config.js','session-identity.js','session-bindings.js','usage-sources.js','provider-observation.js','context.js','quota.js'].map(async name=>[name,sha(await fs.readFile(path.join(ROOT,'src/shared',name)))])));
  if(live)liveReceipts.add(receipt);
  let config;try{config=(await readConfig(io)).value;}catch{receipt.status='FAIL';receipt.error='CONFIG_INVALID';return receipt;}
  receipt.pythonVersion=safeVersion(await exec('python3',['--version']));
  const bindings=[];
  try{
    const store=new BindingStore(io),snapshot=await store.read();receipt.bindingStoreStatus=snapshot.raw===null?'absent':'validated';
    for(const record of Object.values(snapshot.value.proposals)){
      if(record.state!=='committed'||!record.session||record.session.machine!==null)continue;
      const result=await exec('hc',['get',record.ack.terminal.address,'--json']);if(result.code!==0)continue;
      try{const full=JSON.parse(result.stdout);if(terminalKey(terminalIdentity(full,null))===terminalKey(record.ack.terminal))bindings.push(record.session);}catch{}
    }
  }catch{receipt.bindingStoreStatus='invalid';}
  for(const provider of ['codex','claude','grok']){
    const row={provider,cliVersion:'unavailable',sourceMode:'standard',sourcesRead:0,disabledSources:0,schemaStatus:'unsupported',formats:[],observedSessions:0,unavailableObservations:0,reportedContextFields:[],reportedQuotaObservations:0,activeExactBindings:0,measuredActiveContext:0,measuredActiveQuota:0,sharedAccountQuota:0,truncated:false,compressedObservations:0};
    const configured=Object.values(config.usageSources).filter(s=>s?.provider===provider&&s.machine===null);
    let sources;
    try{sources=configured.length?configured.map(validateUsageSource):null;}catch{row.error='SOURCE_CONFIG_INVALID';receipt.providers.push(row);continue;}
    if(configured.length){row.sourceMode='configured';row.disabledSources=sources.filter(s=>!s.enabled).length;sources=sources.filter(s=>s.enabled);}
    if(sources?.length===0){row.schemaStatus='disabled';receipt.providers.push(row);continue;}
    row.cliVersion=safeVersion(await exec(provider,['--version']));
    if(row.cliVersion==='unavailable'||row.cliVersion==='unverified'){row.error='CLI_UNSUPPORTED';receipt.providers.push(row);continue;}
    if(receipt.pythonVersion==='unavailable'||receipt.pythonVersion==='unverified'){row.error='PYTHON_UNAVAILABLE';receipt.providers.push(row);continue;}
    sources=sources||Object.values(defaultUsageSources({home,machine:null,installed:[{key:provider,installed:true}]}));
    const all=[],fields=new Set(),formats=new Set(),identities=new Set(),bound=new Set(bindings.map(sessionKey)),exactBindings=new Set(),measuredContext=new Set(),measuredQuota=new Set(),sharedQuota=new Set();
    for(const source of sources){
      // Standard-root only unless the source settings explicitly configure an
      // extra root/cache. This never discovers or refreshes a legacy plugin.
      const response=await exec('python3',['-c',code,JSON.stringify({v:1,operation:'list',source,roots:source.roots,limit:50})]);
      if(response.code!==0){row.error='COLLECTOR_FAILED';continue;}
      let data;try{data=JSON.parse(response.stdout);}catch{row.error='COLLECTOR_MALFORMED';continue;}
      if(data.v!==1||data.state==='error'||!Array.isArray(data.data)||data.data.length>50||!data.scope||!['machine','provider','credentialScope','providerRoot'].every(k=>data.scope[k]===source[k])){row.error='COLLECTOR_SCOPE_INVALID';continue;}
      row.sourcesRead++;row.truncated=row.truncated||data.truncated===true;
      for(const observation of data.data){
        const valid=validateProviderObservation(observation);if(!valid.ok||observation.provenance.provider!==provider){row.error='OBSERVATION_INVALID';continue;}
        if(observation.state!=='available'){row.unavailableObservations++;if(observation.code==='UNSUPPORTED_COMPRESSION')row.compressedObservations++;continue;}
        if(!['machine','provider','credentialScope','providerRoot'].every(k=>observation.identity[k]===source[k])){row.error='OBSERVATION_SCOPE_INVALID';continue;}
        const key=sessionKey(observation.identity);identities.add(key);formats.add(observation.provenance.format);for(const[k,v]of Object.entries(observation.context||{}))if(v!==null)fields.add(k);
        if(observation.quota)row.reportedQuotaObservations++;
        if(bound.has(key)){exactBindings.add(key);const context=normalizeContext(observation,observation.identity,{now}),quota=normalizeQuota(observation,observation.identity,{now});if(context.state==='available')measuredContext.add(key);if(quota.state==='available'){measuredQuota.add(key);if(quota.scope==='shared-account')sharedQuota.add(key);}}
        all.push(observation);
      }
    }
    row.formats=[...formats].sort();row.reportedContextFields=[...fields].sort();row.observedSessions=identities.size;row.activeExactBindings=exactBindings.size;row.measuredActiveContext=measuredContext.size;row.measuredActiveQuota=measuredQuota.size;row.sharedAccountQuota=sharedQuota.size;row.schemaStatus=all.length?'observed-compatible':'unsupported';receipt.providers.push(row);
  }
  receipt.status=receipt.bindingStoreStatus!=='invalid'&&['codex','claude'].every(provider=>receipt.providers.find(r=>r.provider===provider)?.schemaStatus==='observed-compatible')?'PASS':'FAIL';
  if(live)liveReceipts.add(receipt);
  return receipt;
}

export function verifyLiveReceipt(receipt){
  if(!liveReceipts.has(receipt)||receipt.evidenceKind!=='live-installed-metadata')throw Error('Fixture or deserialized evidence cannot prove an installed-provider check; run verify live.');
  if(receipt.status!=='PASS'||receipt.probeSourceSha256!==SOURCE_HASH||receipt.collectorBytes>65536)throw Error('Installed Codex/Claude schema compatibility is unproven.');
  const text=JSON.stringify(receipt);
  if(/"(?:sessionId|accountId|credentialScope|providerRoot|cwd|title|token|password|authorization)"\s*:|\/Users\/|\/private\/tmp\//i.test(text))throw Error('Compatibility receipt contains private identity/content fields.');
  return true;
}

async function main(){
  if(process.argv[2]!=='verify')throw Error('Usage: node scripts/provider-compatibility.mjs verify');
  const receipt=await probeInstalledProviders();
  let error;try{verifyLiveReceipt(receipt);}catch(failure){error=failure;}
  await fs.mkdir(path.join(ROOT,'evidence/native'),{recursive:true});await fs.writeFile(path.join(ROOT,'evidence/native/provider-compatibility.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));if(error)throw error;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
