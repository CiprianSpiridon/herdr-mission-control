import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const receipt={v:1,date:new Date().toISOString(),platform:process.platform,probes:[],boundary:'Fresh anonymous profile help/status only, with network, Mach IPC, OS credential helper execution and real provider/Keychain paths denied by a child macOS sandbox. No login/logout, auth-file copying, existing-session query or paid turn.'};
function environment(directory,profile,base=process.env){
  const env={};for(const key of ['PATH','LANG','LC_ALL','TZ','TERM'])if(typeof base[key]==='string')env[key]=base[key];
  return {...env,HOME:path.join(directory,'home'),USERPROFILE:path.join(directory,'home'),XDG_CONFIG_HOME:path.join(directory,'config'),XDG_DATA_HOME:path.join(directory,'data'),XDG_STATE_HOME:path.join(directory,'state'),XDG_CACHE_HOME:path.join(directory,'cache'),TMPDIR:path.join(directory,'tmp'),CODEX_HOME:profile,CLAUDE_CONFIG_DIR:profile,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DO_NOT_TRACK:'1'};
}
async function binary(name){for(const directory of (process.env.PATH||'').split(path.delimiter)){if(!path.isAbsolute(directory))continue;const file=path.join(directory,name);try{await fs.access(file,fs.constants.X_OK);return fs.realpath(file);}catch{}}throw Error('Required installed CLI is unavailable: '+name);}
async function fixture(t){
  if(process.platform!=='darwin')throw Error('This versioned profile gate requires macOS; no unsupported platform can claim credential isolation.');
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-account-profile-'))),a=path.join(directory,'profile-a'),b=path.join(directory,'profile-b'),canary=path.join(directory,'existing-canary'),realHome=os.homedir();
  for(const name of ['home','config','data','state','cache','tmp','profile-a','profile-b','existing-canary'])await fs.mkdir(path.join(directory,name));await fs.writeFile(path.join(canary,'auth.json'),'owned-canary-do-not-read\n');
  const executable=await binary('claude'),protectedPaths=[canary,realHome,'/Library/Keychains','/Library/Application Support/ClaudeCode','/Library/Application Support/OpenAI','/etc/codex','/etc/claude','/etc/anthropic'];
  const quote=value=>JSON.stringify(value),policy=path.join(directory,'probe.sb');
  await fs.writeFile(policy,`(version 1)\n(allow default)\n(deny network*)\n(deny mach-lookup)\n(deny process-exec (literal "/usr/bin/security"))\n(deny file-write*)\n(allow file-write* (subpath ${quote(directory)}) (literal "/dev/null"))\n${protectedPaths.map(file=>`(deny file-read* file-write* (subpath ${quote(file)}))`).join('\n')}\n(allow file-read* (literal ${quote(executable)}))\n`);
  const canaryBefore=await fs.readFile(path.join(canary,'auth.json'),'utf8');
  t.after(async()=>{assert.equal(await fs.readFile(path.join(canary,'auth.json'),'utf8'),canaryBefore,'Owned pre-existing credential canary changed');await fs.rm(directory,{recursive:true,force:true});});
  return {directory,a,b,canary,policy,protectedPaths,env:profile=>environment(directory,profile),run(executable,args,profile=a){
    const result=spawnSync('/usr/bin/sandbox-exec',['-f',policy,executable,...args],{cwd:directory,env:environment(directory,profile),input:'',encoding:'utf8',timeout:15000,maxBuffer:256*1024});
    if(result.error||result.signal||!Number.isInteger(result.status))throw Error('The bounded credential-isolated probe failed before it produced a status.');
    return {code:result.status,stdout:result.stdout||'',stderr:result.stderr||''};
  }};
}
const allowed=(tool,args)=>tool==='codex'?[['--version'],['--help'],['login','--help'],['login','status'],['logout','--help']].some(a=>JSON.stringify(a)===JSON.stringify(args)):tool==='claude'?[['--version'],['--help'],['auth','--help'],['auth','status'],['auth','logout','--help']].some(a=>JSON.stringify(a)===JSON.stringify(args)):false;
async function probe(f,tool,args,profile=f.a){
  if(!allowed(tool,args))throw Error('Feasibility permits only fixed, non-authenticating help/status commands.');
  const executable=await binary(tool),result=f.run(executable,args,profile);
  receipt.probes.push({tool,argv:args,profile:profile===f.a?'A':'B',code:result.code,stdoutSha256:digest(result.stdout),stderrSha256:digest(result.stderr),stdoutBytes:Buffer.byteLength(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),sandbox:'network/mach/keychain denied; private writes only'});return result;
}
function expect(condition,message){if(!condition)throw Error(message);}

test('profile probe environment cannot inherit credentials, real homes, proxies or Herdr selectors',()=>{
  const env=environment('/private/tmp/profile-fixture','/private/tmp/profile-fixture/a',{PATH:'/usr/bin:/bin',HOME:'/real',OPENAI_API_KEY:'fixture-do-not-inherit',CLAUDE_CODE_OAUTH_TOKEN:'fixture-do-not-inherit',ANTHROPIC_PROFILE:'other',AWS_PROFILE:'other',GH_TOKEN:'fixture-do-not-inherit',HTTPS_PROXY:'private',HC_SESSION:'live',HERDR_APP_HOME:'/real/app',CODEX_HOME:'/real/codex',CLAUDE_CONFIG_DIR:'/real/claude',NODE_OPTIONS:'--require /real/hooks.js'});
  for(const key of ['OPENAI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_PROFILE','AWS_PROFILE','GH_TOKEN','HTTPS_PROXY','HC_SESSION','HERDR_APP_HOME','NODE_OPTIONS'])assert.equal(env[key],undefined);
  assert.equal(env.CODEX_HOME,'/private/tmp/profile-fixture/a');assert.equal(env.CLAUDE_CONFIG_DIR,env.CODEX_HOME);assert.equal(env.HOME,'/private/tmp/profile-fixture/home');
  for(const args of [[],['login'],['logout'],['exec','anything'],['auth','login'],['auth','logout'],['setup-token']])for(const tool of ['codex','claude'])assert.equal(allowed(tool,args),false);
});

test('the kernel denies a credential canary and writes outside the task directory before CLI probes',async t=>{
  const f=await fixture(t),python=await binary('python3');
  const script=`import sys\ntry:\n open(sys.argv[1]).read()\nexcept PermissionError:\n print('denied')\nelse:\n raise RuntimeError('credential isolation failed')\n`;
  const denied=f.run(python,['-c',script,path.join(f.canary,'auth.json')]);expect(denied.code===0&&denied.stdout.trim()==='denied','Kernel credential-path denial is not proven.');
  const write=f.run(python,['-c',"import sys\ntry:\n open('/private/tmp/mc-account-unowned-write','w').write('forbidden')\nexcept PermissionError:\n print('denied')\nelse:\n raise RuntimeError('write isolation failed')"]);expect(write.code===0&&write.stdout.trim()==='denied','Kernel private-write boundary is not proven.');
  const security=f.run('/usr/bin/security',['help']);expect(security.code!==0,'OS credential helper execution was not blocked.');receipt.kernelGuards={canaryReadDenied:true,unownedWriteDenied:true,securityExecutionDenied:true,machLookupPolicy:'deny-all',networkPolicy:'deny-all',existingHomeReadPolicy:'deny except the installed Claude executable',managedProviderConfigurationPolicy:'deny-read-write'};
});

test('installed Codex help and anonymous file-backend status use two fresh independent roots',async t=>{
  const f=await fixture(t);for(const profile of [f.a,f.b])await fs.writeFile(path.join(profile,'config.toml'),'cli_auth_credentials_store = "file"\n');
  const version=await probe(f,'codex',['--version']);expect(version.code===0&&/^codex-cli [0-9]+\.[0-9]+\.[0-9]+/.test(version.stdout.trim()),'Codex version cannot be verified in the denied-credential sandbox.');receipt.codexVersion=version.stdout.trim();
  const help=await probe(f,'codex',['--help']);expect(help.code===0&&help.stdout.includes('login')&&help.stdout.includes('logout'),'Installed Codex authentication commands differ from the reviewed contract.');
  const loginHelp=await probe(f,'codex',['login','--help']);expect(loginHelp.code===0&&loginHelp.stdout.includes('status'),'Installed Codex has no verified read-only login status.');
  const logoutHelp=await probe(f,'codex',['logout','--help']);expect(logoutHelp.code===0&&/credential|auth|login/i.test(logoutHelp.stdout),'Codex logout scope cannot even be described by installed help.');
  for(const profile of [f.a,f.b]){
    const status=await probe(f,'codex',['login','status'],profile);expect(status.code===1&&/not logged in/i.test(status.stdout+'\n'+status.stderr),'Fresh Codex root did not produce the expected anonymous status; output was discarded.');
    expect(await fs.readFile(path.join(profile,'config.toml'),'utf8')==='cli_auth_credentials_store = "file"\n','Codex changed the owned profile backend selection.');expect(!(await fs.readdir(profile)).includes('auth.json'),'A status-only Codex probe unexpectedly created an auth cache.');
  }
  // Loading a deliberately invalid owned config proves CODEX_HOME is read;
  // a successful help output alone would not establish profile selection.
  await fs.writeFile(path.join(f.b,'config.toml'),'cli_auth_credentials_store = "mission-control-invalid-backend"\n');
  const invalid=await probe(f,'codex',['login','status'],f.b);expect(invalid.code!==0&&/mission-control-invalid-backend/.test(invalid.stderr+'\n'+invalid.stdout),'Codex did not load the deliberately invalid B configuration.');
  const unchanged=await probe(f,'codex',['login','status'],f.a);expect(unchanged.code===1&&/not logged in/i.test(unchanged.stdout+'\n'+unchanged.stderr),'Changing B affected anonymous profile A.');receipt.codex={profileRouting:'observed-config-selection',anonymousStatus:'A-and-B-not-logged-in',backend:'file-requested; keychain access denied',authenticatedIsolation:'not-tested',logoutExecuted:false,runningSessionSwitch:'not-tested'};
});

test('installed Claude status names each fresh config root without querying the OS credential backend',async t=>{
  const f=await fixture(t);const version=await probe(f,'claude',['--version']);expect(version.code===0&&/^[0-9]+\.[0-9]+\.[0-9]+/.test(version.stdout.trim()),'Claude version cannot be verified in the denied-credential sandbox.');receipt.claudeVersion=version.stdout.trim();
  const help=await probe(f,'claude',['--help']);expect(help.code===0&&help.stdout.includes('auth'),'Installed Claude has no verified auth command.');
  const auth=await probe(f,'claude',['auth','--help']);expect(auth.code===0&&auth.stdout.includes('status')&&auth.stdout.includes('logout'),'Installed Claude auth help differs from the reviewed contract.');
  const logout=await probe(f,'claude',['auth','logout','--help']);expect(logout.code===0&&/logout|log out/i.test(logout.stdout),'Claude logout command is not described by installed help.');
  for(const profile of [f.a,f.b]){
    const status=await probe(f,'claude',['auth','status'],profile);let value;try{value=JSON.parse(status.stdout);}catch{throw Error('Claude anonymous status was not JSON; output was discarded.');}
    expect(status.code===1&&value.loggedIn===false&&value.authMethod==='none','Fresh Claude status unexpectedly found authentication; output was discarded.');expect(value.configDirectory===profile,'Claude auth status did not select the requested fresh configuration root.');
    expect(!(await fs.readdir(profile)).includes('.credentials.json'),'A status-only Claude probe unexpectedly wrote credentials.');
  }
  receipt.claude={profileRouting:'observed-configDirectory-in-A-and-B',anonymousStatus:'A-and-B-not-logged-in',backend:'OS credential access denied; no login tested',authenticatedIsolation:'documented-except-keyless-Console; not-tested',logoutExecuted:false,runningSessionSwitch:'not-tested'};
});

after(async()=>{await fs.mkdir('.harness',{recursive:true});await fs.writeFile('.harness/account-profile-probes.json',JSON.stringify(receipt,null,2)+'\n');});
