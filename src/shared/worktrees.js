import {canonicalRepoPath} from './config.js';
import {machineIdentity} from './session-identity.js';
export class WorktreeError extends Error {constructor(code,message){super(message);this.name='WorktreeError';this.code=code;}}
const fail=(code,message)=>{throw new WorktreeError(code,message);};
const copy=v=>JSON.parse(JSON.stringify(v));
const text=(v,label,max=512)=>{if(typeof v!=='string'||!v||v.length>max||/[\u0000-\u001f]/.test(v))fail('INVALID_WORKTREE',`Invalid ${label}`);return v;};
export function requestDigest(value){
  text(value,'request ID',256);let a=2166136261,b=0x9e3779b9;
  for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),2246822519);}
  return [(a>>>0),(b>>>0)].map(n=>n.toString(16).padStart(8,'0')).join('').slice(0,12);
}
export function slug(value,max=64){
  text(value,'worktree name');const v=value.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,max).replace(/-+$/,'');
  if(!v||v==='.'||v==='..')fail('INVALID_WORKTREE','Worktree name has no safe characters');return v;
}
function defaultLocation(request,spaceName,name){
  const repoRoot=canonicalRepoPath(request.repoRoot),parent=repoRoot.slice(0,repoRoot.lastIndexOf('/'))||'/';
  const leaf=slug(spaceName||request.spaceId||'space',48)+'-'+(name?slug(name,64):request.source?slug(request.source.key,64):'task-'+requestDigest(request.requestId));
  return {worktreePath:`${parent==='/'?'':parent}/.herdr-worktrees/${leaf}`,branch:`mission-control/${leaf}`,leaf};
}
/** Convert the launch form's optional friendly name into the canonical path expected by launch(). */
export function resolveWorktreeChoice(request,{spaceName,value='',branch=''}={}){
  const input=value.trim(),absolute=input.startsWith('/')||/^[A-Za-z]:[\\/]/.test(input);
  if(input&&!absolute&&(/[\\/]/.test(input)||input.startsWith('~')||input==='.'||input==='..'))fail('INVALID_WORKTREE','Enter a worktree name, leave it blank for automatic naming, or use a full absolute folder path.');
  const defaults=defaultLocation(request,spaceName,input&&!absolute?input:undefined);
  let worktreePath=defaults.worktreePath;
  if(absolute){try{worktreePath=canonicalRepoPath(input);}catch{fail('INVALID_WORKTREE','Use an absolute worktree folder without . or .. path segments.');}}
  const chosenBranch=branch.trim();
  if(chosenBranch&&(chosenBranch.startsWith('-')||/[\u0000-\u001f]/.test(chosenBranch)))fail('INVALID_WORKTREE','Enter a valid branch name, or leave it blank for automatic naming.');
  return {worktreePath,branch:chosenBranch||defaults.branch};
}
function sourceIdentity(source){
  if(!source)return null;
  for(const field of ['kind','connectionId','site','id','key'])text(source[field],`source ${field}`,field==='site'?2048:512);
  if(!['jira','github','github-pr','gitlab','gitlab-mr'].includes(source.kind)||!/^https:\/\/[^\s/@?#]+\/?$/.test(source.site))fail('INVALID_WORKTREE','Unsupported tracker source identity');
  if(source.url!==undefined||['gitlab','gitlab-mr'].includes(source.kind)){text(source.url,'source URL',2048);if(!/^https:\/\/[^\s@]+$/.test(source.url))fail('INVALID_WORKTREE','Unsupported tracker source URL');}
  return JSON.stringify([source.kind,source.connectionId,source.site,source.id]);
}
function requestShape(request){
  if(!request||typeof request.worktree!=='boolean')fail('INVALID_WORKTREE','A boolean worktree choice is required');
  text(request.requestId,'request ID',256);text(request.originId,'origin ID',256);
  if(!request.source&&request.checkoutRoot===undefined)fail('INVALID_WORKTREE','Generic launches require the captured checkoutRoot');
  const machine=machineIdentity(request.machine),repoRoot=canonicalRepoPath(request.repoRoot),checkoutRoot=canonicalRepoPath(request.checkoutRoot??request.repoRoot),sourceKey=sourceIdentity(request.source);
  if(!request.worktree&&(request.worktreePath!==undefined||request.branch!==undefined))fail('INVALID_WORKTREE','Worktree path/branch overrides require a new worktree');
  if(request.worktreePath!==undefined)canonicalRepoPath(request.worktreePath);
  if(request.branch!==undefined){text(request.branch,'branch',200);if(request.branch.startsWith('-'))fail('INVALID_WORKTREE','Invalid branch');}
  return {machine,repoRoot,checkoutRoot,sourceKey};
}

// Filesystem-sensitive checks and the Git mutation run together on the target
// host under a kernel-released lock. No command string contains task text.
const HELPER=String.raw`
import os,sys,json,stat,hashlib,subprocess,tempfile
try:
 import fcntl
except ImportError:
 print(json.dumps({"ok":False,"code":"UNSUPPORTED_HOST","message":"Safe worktrees require Python with POSIX locking"}));sys.exit(0)
class Failure(Exception):
 def __init__(self,code,message): self.code=code;self.message=message
def stop(code,message): raise Failure(code,message)
def git(repo,args,check=True):
 p=subprocess.run(["git","-C",repo]+args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if check and p.returncode: stop("GIT_FAILED","Git rejected the worktree operation; existing work was preserved")
 return p
def safe(path):
 if not os.path.isabs(path) or os.path.normpath(path)!=path: stop("UNSAFE_PATH","A canonical absolute path is required")
 current="/"
 for part in path.split("/")[1:]:
  current=os.path.join(current,part)
  if os.path.lexists(current) and stat.S_ISLNK(os.lstat(current).st_mode): stop("SYMLINK_PATH","Worktree paths cannot pass through symlinks")
def root_for(repo):
 resolved=os.path.realpath(git(repo,["rev-parse","--show-toplevel"]).stdout.strip())
 if resolved!=repo: stop("REPO_CHANGED","The canonical repository root changed")
 return resolved
def same_checkout(repo,checkout):
 safe(checkout);root_for(checkout)
 a=os.path.realpath(git(repo,["rev-parse","--path-format=absolute","--git-common-dir"]).stdout.strip())
 b=os.path.realpath(git(checkout,["rev-parse","--path-format=absolute","--git-common-dir"]).stdout.strip())
 if a!=b: stop("CHECKOUT_MISMATCH","The selected checkout belongs to a different canonical repository")
def branches(repo):
 output=git(repo,["worktree","list","--porcelain"]).stdout
 return [dict(line.split(" ",1) if " " in line else (line,True) for line in block.splitlines()) for block in output.strip().split("\n\n") if block]
def check_spec(s):
 for k in ["path","repoRoot"]: safe(s[k])
 root_for(s["repoRoot"])
 same_checkout(s["repoRoot"],s["checkoutRoot"])
 if s["path"]==s["repoRoot"] or s["path"].startswith(s["repoRoot"]+"/"): stop("UNSAFE_PATH","A worktree must be outside its source repository")
 if s["repoRoot"].startswith(s["path"].rstrip("/")+"/"): stop("UNSAFE_PATH","A worktree cannot replace a repository ancestor")
 git(s["repoRoot"],["check-ref-format","--branch",s["branch"]])
 base=git(s["repoRoot"],["rev-parse","--verify",s["base"]+"^{commit}"]).stdout.strip()
 if base!=s["base"]: stop("BASE_CHANGED","Captured base commit is invalid")
def main(q):
 repo=q["repoRoot"];safe(repo);root_for(repo)
 if q["action"]=="prepare":
  branch=q["branch"];git(repo,["check-ref-format","--branch",branch])
  target=q["path"];safe(target)
  same_checkout(repo,q["checkoutRoot"])
  s={k:q[k] for k in ["requestId","originId","machine","repoRoot","checkoutRoot","sourceKey","path","branch","leaf"]}
  s["v"]=1;s["base"]=git(q["checkoutRoot"],["rev-parse","--verify","HEAD^{commit}"]).stdout.strip();check_spec(s)
  if os.path.lexists(target) or any(os.path.realpath(w["worktree"])==target for w in branches(repo)): stop("WORKTREE_EXISTS","The requested path already exists and is not owned by this request")
  if git(repo,["show-ref","--verify","--quiet","refs/heads/"+branch],False).returncode==0: stop("BRANCH_EXISTS","The requested branch already exists")
  return {"ok":True,"spec":s}
 s=q["spec"];check_spec(s)
 common=os.path.realpath(git(repo,["rev-parse","--path-format=absolute","--git-common-dir"]).stdout.strip())
 owned=os.path.join(common,"mission-control","worktrees");safe(owned);os.makedirs(owned,mode=0o700,exist_ok=True);safe(owned)
 lockpath=os.path.join(owned,".lock");fd=os.open(lockpath,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: stop("WORKTREE_BUSY","Another worktree request is being committed; retry this same request")
  marker=os.path.join(owned,hashlib.sha256(s["requestId"].encode()).hexdigest()+".json");safe(marker)
  saved=None
  if os.path.lexists(marker):
   if not stat.S_ISREG(os.lstat(marker).st_mode) or os.path.getsize(marker)>32768: stop("OWNERSHIP_INVALID","Worktree ownership metadata is invalid")
   with open(marker) as f: saved=json.load(f)
   if saved.get("spec")!=s: stop("RETRY_CHANGED","The request has different captured worktree parameters")
  entries=branches(repo);matching=[w for w in entries if os.path.realpath(w["worktree"])==s["path"]]
  exists=os.path.lexists(s["path"]);branch_exists=git(repo,["show-ref","--verify","--quiet","refs/heads/"+s["branch"]],False).returncode==0
  if saved and saved.get("state")=="created":
   if len(matching)!=1 or matching[0].get("branch")!="refs/heads/"+s["branch"] or not os.path.isdir(s["path"]): stop("OWNERSHIP_CHANGED","The owned worktree was moved or changed; inspect it before retrying")
   return {"ok":True,"folder":s["path"],"reused":True,"spec":s}
  if exists or branch_exists or matching: stop("WORKTREE_RECOVERY_REQUIRED" if saved else "WORKTREE_EXISTS","Existing path/ref cannot be overwritten or adopted; inspect the captured request")
  def save(state):
   f,tmp=tempfile.mkstemp(prefix=".mc-",dir=owned)
   try:
    with os.fdopen(f,"w") as out: json.dump({"v":1,"state":state,"spec":s},out);out.flush();os.fsync(out.fileno())
    os.replace(tmp,marker)
   finally:
    if os.path.exists(tmp): os.unlink(tmp)
  save("proposed")
  parent=os.path.dirname(s["path"]);safe(parent);os.makedirs(parent,mode=0o700,exist_ok=True);safe(parent)
  git(repo,["worktree","add","-b",s["branch"],s["path"],s["base"]])
  safe(s["path"]);save("created")
  return {"ok":True,"folder":s["path"],"reused":False,"spec":s}
 finally: os.close(fd)
try:
 q=json.loads(sys.argv[1]);print(json.dumps(main(q)))
except Failure as e: print(json.dumps({"ok":False,"code":e.code,"message":e.message}))
except Exception: print(json.dumps({"ok":False,"code":"WORKTREE_ERROR","message":"Worktree operation failed; inspect the captured request before retrying"}))
`;
async function execute(exec,machine,query){
  if(typeof exec!=='function')fail('UNSUPPORTED_HOST','Target-host execution is unavailable');
  let r;try{r=await exec('python3',['-c',HELPER,JSON.stringify(query)],{on:machine});}catch{fail('UNSUPPORTED_HOST','Python/Git could not run on the selected machine');}
  if(r.code!==0)fail('WORKTREE_ERROR','The target-host worktree helper failed');
  let result;try{result=JSON.parse(r.stdout);}catch{fail('WORKTREE_ERROR','Invalid target-host worktree response');}
  if(!result.ok)fail(result.code||'WORKTREE_ERROR',result.message||'Worktree operation failed');return result;
}
export async function prepareWorktree(request,{spaceName,exec}={}){
  const shape=requestShape(request);
  if(!request.worktree){
    await validateCheckout(shape,exec);
    return {v:1,requestId:request.requestId,originId:request.originId,...shape,path:shape.checkoutRoot,worktree:false};
  }
  const defaults=defaultLocation(request,spaceName),leaf=defaults.leaf;
  const target=request.worktreePath?canonicalRepoPath(request.worktreePath):defaults.worktreePath;
  const branch=request.branch||defaults.branch;
  const result=await execute(exec,shape.machine,{action:'prepare',requestId:request.requestId,originId:request.originId,...shape,path:target,branch,leaf});
  return {...result.spec,worktree:true};
}
export async function ensureWorktree(request,captured,{exec}={}){
  const shape=requestShape(request),spec=copy(captured);
  if(spec?.v!==1||spec.requestId!==request.requestId||spec.originId!==request.originId||spec.machine!==shape.machine||spec.repoRoot!==shape.repoRoot||spec.checkoutRoot!==shape.checkoutRoot||spec.sourceKey!==shape.sourceKey||spec.worktree!==request.worktree)fail('RETRY_CHANGED','The request differs from its immutable captured worktree');
  if(request.worktreePath!==undefined&&canonicalRepoPath(request.worktreePath)!==spec.path||request.branch!==undefined&&request.branch!==spec.branch)fail('RETRY_CHANGED','Captured worktree path/ref cannot change on retry');
  if(!spec.worktree){await validateCheckout(shape,exec);return {ok:true,folder:shape.checkoutRoot,reused:true,spec};}
  if(typeof spec.base!=='string'||!/^[a-f0-9]{40,64}$/.test(spec.base)||typeof spec.branch!=='string')fail('INVALID_WORKTREE','Invalid captured worktree');
  const payload={...spec};delete payload.worktree;
  return execute(exec,shape.machine,{action:'create',repoRoot:shape.repoRoot,spec:payload});
}
async function validateCheckout(shape,exec){
  const read=async(cwd,args)=>{const r=await exec('git',args,{cwd,on:shape.machine});if(r.code!==0)fail('CHECKOUT_MISMATCH','The captured checkout is unavailable');return canonicalRepoPath(r.stdout.trim());};
  const main=await read(shape.repoRoot,['rev-parse','--show-toplevel']),checkout=await read(shape.checkoutRoot,['rev-parse','--show-toplevel']);
  if(main!==shape.repoRoot||checkout!==shape.checkoutRoot)fail('CHECKOUT_MISMATCH','The captured checkout root changed');
  const a=await read(main,['rev-parse','--path-format=absolute','--git-common-dir']),b=await read(checkout,['rev-parse','--path-format=absolute','--git-common-dir']);
  if(a!==b)fail('CHECKOUT_MISMATCH','The selected checkout belongs to a different canonical repository');
}
