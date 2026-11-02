import {canonicalRepoPath} from './config.js';
import {machineIdentity} from './session-identity.js';
const line=value=>value.replace(/\r?\n$/,'');
function base(space){return {spaceId:space.id,machine:machineIdentity(space.machine)};}
async function git(exec,cwd,on,args){const r=await exec('git',['-C',cwd,...args],{on});return r.code===0?r.stdout:null;}
async function resolvePane(space,pane,exec){
  const target={...base(space),paneId:pane.pane,cwd:pane.cwd};
  try{
    const cwd=canonicalRepoPath(pane.cwd),top=await git(exec,cwd,target.machine,['rev-parse','--path-format=absolute','--show-toplevel']);
    if(top===null)return {...target,state:'unbound',reason:'No Git repository at this live terminal folder.'};
    const worktreeRoot=canonicalRepoPath(line(top)),common=await git(exec,worktreeRoot,target.machine,['rev-parse','--path-format=absolute','--git-common-dir']);
    if(common===null)return {...target,state:'error',reason:'The Git common directory is unavailable.'};
    const gitCommonDir=canonicalRepoPath(line(common)),list=await git(exec,worktreeRoot,target.machine,['worktree','list','--porcelain','-z']);
    if(list===null)return {...target,state:'error',reason:'Cannot inspect the canonical Git worktree list.'};
    const roots=list.split('\0').filter(v=>v.startsWith('worktree ')).map(v=>canonicalRepoPath(v.slice(9)));
    if(!roots.length||!roots.includes(worktreeRoot))return {...target,state:'error',reason:'The live checkout is absent from its own Git worktree list.'};
    // Git lists the primary worktree first. Keep this identity across checkouts.
    const repoRoot=roots[0],mainCommon=await git(exec,repoRoot,target.machine,['rev-parse','--path-format=absolute','--git-common-dir']);
    if(mainCommon===null||canonicalRepoPath(line(mainCommon))!==gitCommonDir)return {...target,state:'error',reason:'Canonical repository/common-directory identity could not be verified.'};
    return {...target,state:'resolved',worktreeRoot,repoRoot,gitCommonDir,finderPath:target.machine===null?worktreeRoot:null};
  }catch{return {...target,state:'error',reason:'The selected machine, live folder or Git repository is unavailable.'};}
}
const MOUNT_PROBE='import os,sys,json; p=sys.argv[1]; print(json.dumps({"valid":os.path.isabs(p) and p!="/" and os.path.isdir(p) and os.path.realpath(p)==p}))';
async function withMount(result,path,exec){
  if(result.state!=='resolved'||result.machine===null||!path)return result;
  if(result.worktreeRoot!==result.repoRoot)return {...result,finderReason:'This linked checkout has no configured local mount.'};
  try{
    const local=canonicalRepoPath(path),probe=await exec('python3',['-c',MOUNT_PROBE,local]);
    if(probe.code===0&&JSON.parse(probe.stdout).valid===true)return {...result,finderPath:local};
  }catch{}
  return {...result,finderPath:null,finderReason:'The configured local mount is unavailable or is not a canonical directory.'};
}
/** No creation-folder or selected-space fallback: only live panes in this space. */
export async function resolveSpaceRepo(space,panes,exec,{mountedLocalPath=null}={}){
  if(!space?.id||typeof exec!=='function')return {state:'error',spaceId:space?.id??null,machine:space?.machine??null,reason:'Space or target-host execution is unavailable.'};
  const tabs=new Set((space.tabs||[]).map(t=>t.id));
  const eligible=panes.filter(p=>p.terminal&&p.cwd&&tabs.has(p.tab));
  if(!eligible.length)return {...base(space),state:'unbound',reason:'This space has no live terminal folder. Open or focus a terminal first.'};
  // A just-hidden space can retain its old pane focus during a native frame
  // transition. Inactive spaces have no current keyboard-focus preference.
  const focused=space.active===false?[]:eligible.filter(p=>p.focused),chosen=focused.length?focused:eligible;
  const results=[];
  // Bounded per-space work; preserve native tab/pane order.
  for(let start=0;start<chosen.length;start+=4)results.push(...await Promise.all(chosen.slice(start,start+4).map(p=>resolvePane(space,p,exec))));
  if(results.some(r=>r.state==='error'))return {...base(space),state:'error',reason:results.find(r=>r.state==='error').reason};
  const resolved=results.filter(r=>r.state==='resolved');
  if(!resolved.length)return {...base(space),state:'unbound',reason:'No live terminal in this space has a Git repository.'};
  if(resolved.length!==results.length||new Set(resolved.map(r=>r.gitCommonDir)).size!==1)return {...base(space),state:'ambiguous',candidates:results.map(r=>({paneId:r.paneId,cwd:r.cwd,repoRoot:r.repoRoot??null})),reason:'Focus a terminal to choose the repository for this space.'};
  return withMount(resolved[0],mountedLocalPath,exec);
}
export function launchTarget(resolved){
  if(resolved?.state!=='resolved')throw Object.assign(Error(resolved?.reason||'Choose a resolved repository first'),{code:'REPO_UNRESOLVED'});
  return {spaceId:resolved.spaceId,machine:resolved.machine,repoRoot:resolved.repoRoot,checkoutRoot:resolved.worktreeRoot};
}
