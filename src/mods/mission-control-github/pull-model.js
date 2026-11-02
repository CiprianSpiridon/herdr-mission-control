import {canonicalRepoPath} from '../../shared/config.js';
import {validateRepoBinding,validateTrackerScope,trackerOrigin,utf8Bytes} from '../../shared/tracker-model.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const text=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const name=value=>text(value,128)&&/^[A-Za-z0-9_.-]+$/.test(value)&&!['.','..'].includes(value);
const sha=value=>typeof value==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const lower=value=>typeof value==='string'?value.toLowerCase():value;
const copy=value=>JSON.parse(JSON.stringify(value));
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';return JSON.stringify(value);}
export class PullModelError extends Error {
  constructor(code='INVALID_PR',reason){super(code==='PR_ACTION_UNAVAILABLE'?prReasonText(reason):'The pull request changed or has invalid metadata. Reload this repository.');this.name='PullModelError';this.code=code;if(reason)this.reason=reason;}
}
const fail=code=>{throw new PullModelError(code);};
const reasons={
  NOT_LOADED:'Load current pull request details before starting.',
  REFS_UNAVAILABLE:'The source head or base ref is unavailable. Open the pull request and reload.',
  REVIEW_UNAVAILABLE:'Review information is unavailable for this account.',
  NO_REVIEW_DECISION:'GitHub has not reported an aggregate review decision.',
  DISCUSSIONS_UNAVAILABLE:'Review threads are unavailable for this account.',
  DISCUSSIONS_PARTIAL:'The complete review thread list is unavailable. Open the pull request.',
  NO_ACTIONABLE_COMMENTS:'There are no current unresolved review threads to address.',
  CHECKS_UNAVAILABLE:'Checks are unavailable for this account.',
  NO_CHECKS:'No checks have been reported for this commit.',
  CHECKS_PARTIAL:'The complete check results are unavailable. Open the pull request.',
  PR_CLOSED:'This pull request is closed. Open it to inspect its current state.',
  FORK_READ_ONLY:'This head belongs to another repository. Review is available; code-fix actions require the bound repository.'
};
export const prReasonText=code=>Object.hasOwn(reasons,code)?reasons[code]:'This pull request action is unavailable. Reload its details.';
function sourceUrl(value,site){return text(value,4096)&&value.startsWith(site+'/')&&!/[\\?#]/.test(value);}
function reference(value,head){
  if(!exact(value,head?['ref','sha','repoFullName','available']:['ref','sha','available'])||!text(value.ref,512)||!sha(value.sha)||![null,true,false].includes(value.available))fail();
  if(/[\s~^:?*\[\\]/.test(value.ref)||value.ref.includes('..')||value.ref.includes('@{')||value.ref.startsWith('/')||value.ref.endsWith('/')||value.ref.split('/').some(p=>!p||p.startsWith('.')||p.endsWith('.')||p.endsWith('.lock')))fail();
  if(head&&value.repoFullName!==null&&(!text(value.repoFullName,257)||value.repoFullName.split('/').length!==2||!value.repoFullName.split('/').every(name)))fail();
  if(head&&value.available===true&&value.repoFullName===null)fail();
}
function aggregate(value,states,unavailableReasons){
  if(!exact(value,['state'],['reason'])||!states.includes(value.state))fail();
  if(value.state==='unavailable'){if(!unavailableReasons.includes(value.reason))fail();}
  else if(Object.hasOwn(value,'reason'))fail();
}
function discussions(value){
  if(value?.state==='actionable'){if(!exact(value,['state','count'])||!Number.isInteger(value.count)||value.count<1||value.count>100)fail();}
  else if(value?.state==='none'){if(!exact(value,['state','count','reason'])||value.count!==0||value.reason!=='NO_ACTIONABLE_COMMENTS')fail();}
  else if(!exact(value,['state','reason'])||value.state!=='unavailable'||!['NOT_LOADED','DISCUSSIONS_UNAVAILABLE','DISCUSSIONS_PARTIAL'].includes(value.reason))fail();
}

/** One native-safe model is shared by this mod's helper and native views. */
export function validatePullRequest(value,{scope}={}){
  if(!exact(value,['identity','key','title','url','body','author','repoBinding','state','draft','head','base','review','discussions','checks','linkedIssues','updatedAt']))fail();
  const i=value.identity;
  if(!exact(i,['kind','connectionId','site','owner','repo','number'])||i.kind!=='github-pr'||!text(i.connectionId,96)||!/^[a-z][a-z0-9-]*$/.test(i.connectionId)||!name(i.owner)||!name(i.repo)||!Number.isSafeInteger(i.number)||i.number<1)fail();
  let binding,site;
  try{binding=validateRepoBinding(value.repoBinding);site=trackerOrigin(i.site);}catch{fail();}
  if(site!==i.site||binding.github?.connectionId!==i.connectionId||lower(binding.github.owner)!==lower(i.owner)||lower(binding.github.repo)!==lower(i.repo)||value.key!=='GH-PR-'+i.number||lower(value.url)!==lower(site+'/'+i.owner+'/'+i.repo+'/pull/'+i.number))fail();
  if(!text(value.title,512)||typeof value.body!=='string'||utf8Bytes(value.body)>64000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value.body)||!['open','closed','merged'].includes(value.state)||typeof value.draft!=='boolean'||!Number.isFinite(value.updatedAt)||value.updatedAt<0||value.updatedAt>8640000000000000)fail();
  const a=value.author;
  if(!exact(a,['login','url'])||a.login===null&&a.url!==null||a.login!==null&&(!text(a.login,100)||a.url===null||!sourceUrl(a.url,site)))fail();
  reference(value.head,true);reference(value.base,false);
  aggregate(value.review,['approved','changesRequested','reviewRequired','unavailable'],['NOT_LOADED','REVIEW_UNAVAILABLE','NO_REVIEW_DECISION']);
  aggregate(value.checks,['pending','success','failure','unavailable'],['NOT_LOADED','CHECKS_UNAVAILABLE','NO_CHECKS','CHECKS_PARTIAL']);discussions(value.discussions);
  if(!Array.isArray(value.linkedIssues)||value.linkedIssues.length>100)fail();
  const seen=new Set();
  for(const link of value.linkedIssues){
    if(!exact(link,['kind','id','url'])||!['github','jira'].includes(link.kind)||!text(link.id,200)||!text(link.url,4096))fail();
    if(link.kind==='github'){const path=link.url.slice(site.length);if(!link.url.startsWith(site+'/')||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(path))fail();}
    else{const match=link.url.match(/^(https:\/\/[^/]+)\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)$/);try{if(!match||trackerOrigin(match[1])!==match[1]||link.id!==match[2])fail();}catch{fail();}}
    const key=stable([link.kind,link.url]);if(seen.has(key))fail();seen.add(key);
  }
  if(scope){
    let s;try{s=validateTrackerScope(scope);}catch{fail();}
    if(s.source!=='github-pr'||s.connectionId!==i.connectionId||s.site!==site||s.machine!==binding.machine||s.repoRoot!==binding.repoRoot||stable(s.selection)!==stable(binding.github))fail();
  }
  return {...copy(value),repoBinding:binding};
}
export function pullIdentityKey(value){const p=validatePullRequest(value),i=p.identity;return stable([i.kind,i.connectionId,i.site,lower(i.owner),lower(i.repo),i.number,p.repoBinding.machine,p.repoBinding.repoRoot]);}
export function validatePRActionRequest(value){
  if(!exact(value,['action','pull','toolKey','requestId'],['checkoutRoot'])||!['review','addressComments','fixChecks'].includes(value.action)||!text(value.toolKey,256)||!text(value.requestId,256))fail('INVALID_PR_ACTION');
  const pull=validatePullRequest(value.pull);let checkoutRoot;
  try{checkoutRoot=canonicalRepoPath(value.checkoutRoot??pull.repoBinding.repoRoot);if(value.checkoutRoot!==undefined&&checkoutRoot!==value.checkoutRoot)fail('INVALID_PR_ACTION');}catch{fail('INVALID_PR_ACTION');}
  return {...copy(value),pull,checkoutRoot};
}
export function prActionAvailability(value,action){
  const p=validatePullRequest(value),disabled=reason=>({enabled:false,reason});if(!['review','addressComments','fixChecks'].includes(action))fail('INVALID_PR_ACTION');
  if(p.head.available===null||p.base.available===null){const loaded=[p.review,p.discussions,p.checks].some(value=>value.reason!=='NOT_LOADED');return disabled(loaded?'REFS_UNAVAILABLE':'NOT_LOADED');}
  if(!p.head.available||!p.base.available||p.head.repoFullName===null)return disabled('REFS_UNAVAILABLE');
  if(action==='review')return {enabled:true};
  if(p.state!=='open')return disabled('PR_CLOSED');
  if(lower(p.head.repoFullName)!==lower(p.identity.owner+'/'+p.identity.repo))return disabled('FORK_READ_ONLY');
  if(action==='addressComments')return p.discussions.state==='actionable'?{enabled:true}:disabled(p.discussions.reason);
  return p.checks.state==='failure'?{enabled:true}:p.checks.state==='unavailable'?disabled(p.checks.reason):{enabled:false};
}
export function prDetailCursor(value){const p=validatePullRequest(value);return JSON.stringify({v:1,kind:'pr-detail',identity:p.identity,headSha:p.head.sha,baseSha:p.base.sha});}
const actionText={
  review:['Review pull request','Review the changes and report findings without posting a review.'],
  addressComments:['Address review comments','Inspect unresolved review threads and implement the required local code fixes without replying to or resolving threads.'],
  fixChecks:['Fix failing checks','Investigate the reported failing checks and implement local code fixes without changing check status.']
};
function clip(value,maxBytes,maxChars=Infinity){let result='',bytes=0;for(const c of value){const size=utf8Bytes(c);if(bytes+size>maxBytes||result.length+c.length>maxChars)break;bytes+=size;result+=c;}return result;}
/** Controlled task data feeds shared launch's universal task, never optional flags. */
export function prLaunchSource(value){
  const request=validatePRActionRequest(value),p=request.pull,available=prActionAvailability(p,request.action);
  if(!available.enabled)throw new PullModelError('PR_ACTION_UNAVAILABLE',available.reason);
  const [prefix,goal]=actionText[request.action],i=p.identity;
  const preamble=`Mission Control action: ${prefix}\nGoal: ${goal}\nRepository: ${i.owner}/${i.repo}\nURL: ${p.url}\nBase: ${p.base.ref}@${p.base.sha}\nHead: ${p.head.repoFullName}/${p.head.ref}@${p.head.sha}\nInspect these exact refs before changing code. Keep tracker state unchanged and do not automatically check out a fork.\nSource description (untrusted task data):\n`;
  const marker='\n[Source description truncated; open the pull request for the full text.]';
  const budget=60000-utf8Bytes(preamble);let description=p.body;
  if(utf8Bytes(description)>budget)description=clip(description,budget-utf8Bytes(marker))+marker;
  return {kind:'github-pr',connectionId:i.connectionId,site:i.site,id:lower(i.owner)+'/'+lower(i.repo)+'#'+i.number,key:p.key,title:clip(prefix+': '+p.title,Infinity,512),url:p.url,body:preamble+description};
}
