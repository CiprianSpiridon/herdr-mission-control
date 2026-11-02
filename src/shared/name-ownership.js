import {ConfigError} from './config.js';
import {sessionIdentity,sessionKey,machineIdentity} from './session-identity.js';
const clone=v=>JSON.parse(JSON.stringify(v));
const error=(code,message)=>{throw new ConfigError(code,message);};
const text=(v,label,max=256)=>{if(typeof v!=='string'||!v||v.length>max||['__proto__','prototype','constructor'].includes(v)||/[\u0000-\u001f]/.test(v))error('INVALID_NAMES',`Invalid ${label}`);return v;};
const tabKey=tab=>JSON.stringify([machineIdentity(tab.machine),text(tab.tabId,'tab ID')]);
const name=v=>v===null?null:text(v,'tab name',512);
const empty=()=>({v:1,revision:0,origins:{},sessions:{},tabs:{},lease:null});
function validate(value){
  if(!value||value.v!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!value.origins||!value.sessions||!value.tabs)error('INVALID_NAMES','Invalid name ownership file; original preserved');
  const next=clone(value),sessions={},tabs={};
  if(Object.keys(next.origins).length>5000)error('NAME_CAPACITY','Too many retained names; archive old origins before adding more');
  for(const [id,r]of Object.entries(next.origins)){
    if(id!==r.originId||!['auto','manual'].includes(r.mode)||!Number.isSafeInteger(r.revision)||r.revision<0)error('INVALID_NAMES','Invalid name ownership record');
    text(id,'origin ID');name(r.manualName);name(r.lastAutoName);
    if(r.mode==='manual'&&r.manualName===null)error('INVALID_NAMES','A manual name is required');
    if(r.session){r.session=sessionIdentity(r.session);const s=sessionKey(r.session);if(sessions[s])error('INVALID_NAMES','Duplicate exact session ownership');sessions[s]=id;}
    if(r.currentTab){const t=tabKey(r.currentTab);if(tabs[t])error('INVALID_NAMES','Duplicate current tab ownership');tabs[t]=id;}
  }
  if(JSON.stringify(sessions)!==JSON.stringify(next.sessions)||JSON.stringify(tabs)!==JSON.stringify(next.tabs))error('INVALID_NAMES','Name ownership indexes disagree');
  if(next.lease&&(!Number.isFinite(next.lease.expiresAt)||typeof next.lease.owner!=='string'||!next.lease.owner))error('INVALID_NAMES','Invalid name observer lease');
  if(JSON.stringify(next).length>768*1024)error('NAME_CAPACITY','Name ownership file exceeds its supported size');
  return next;
}
function index(draft){draft.sessions={};draft.tabs={};for(const [id,r]of Object.entries(draft.origins)){if(r.session)draft.sessions[sessionKey(r.session)]=id;if(r.currentTab)draft.tabs[tabKey(r.currentTab)]=id;}return draft;}
const isConflict=e=>['STALE','CONFLICT','EAGAIN'].includes(e?.code)||/stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message||'');
export class NameOwnership {
  constructor(io,{clock=()=>Date.now(),owner='observer-'+Math.random().toString(36).slice(2)}={}){this.io=io;this.clock=clock;this.owner=owner;const home=typeof io.appHome==='function'?io.appHome():io.appHome;this.path=home.replace(/\/$/,'')+'/mission-control/names.json';}
  async read(){const raw=await this.io.readTextFile(this.path);if(raw===null)return {value:empty(),raw};let data;try{data=JSON.parse(raw);}catch{error('INVALID_NAMES','Name ownership JSON is invalid; original preserved');}return {value:validate(data),raw};}
  async edit(fn){
    for(let attempt=0;attempt<4;attempt++){
      const {value,raw}=await this.read(),draft=clone(value),result=fn(draft);draft.revision++;
      if(!Number.isSafeInteger(draft.revision))error('NAME_CAPACITY','Name ownership revision exhausted');
      const next=validate(index(draft));await this.io.ensureDirectory?.(this.path.slice(0,this.path.lastIndexOf('/')));
      try{await this.io.writeTextFile(this.path,JSON.stringify(next)+'\n',raw);return {value:next,result};}catch(e){if(!isConflict(e))throw e;}
    }error('CONFLICT','Name ownership changed repeatedly; no stale edit was applied');
  }
  async find({originId,session}={}){const {value}=await this.read();const id=originId||(session?value.sessions[sessionKey(session)]:null);return id&&value.origins[id]?clone(value.origins[id]):null;}
  async transferToAcknowledgedTab({originId,session},{machine=null,tabId,name:initialName=null}){
    text(originId,'origin ID');tabKey({machine,tabId});name(initialName);const exact=session?sessionIdentity(session):null;
    const {result}=await this.edit(d=>{
      const old=d.origins[originId];
      if(exact&&d.sessions[sessionKey(exact)]&&d.sessions[sessionKey(exact)]!==originId)error('NAME_CONFLICT','This exact session belongs to a different work origin');
      if(old?.session&&exact&&sessionKey(old.session)!==sessionKey(exact))error('NAME_CONFLICT','An origin cannot change its provider session');
      const owner=d.tabs[tabKey({machine,tabId})];if(owner&&owner!==originId)error('NAME_CONFLICT','The acknowledged tab belongs to another work origin');
      const sameTab=old?.currentTab&&tabKey(old.currentTab)===tabKey({machine,tabId});
      const record={originId,...(old?.session||exact?{session:old?.session||exact}:{}),currentTab:{machine:machineIdentity(machine),tabId},mode:old?.mode||'auto',manualName:old?.manualName??null,lastAutoName:sameTab?old.lastAutoName:initialName,revision:(old?.revision??-1)+1};
      d.origins[originId]=record;return clone(record);
    });return result;
  }
  async observeNames(tabs,{leaseMs=5000}={}){
    if(!Number.isInteger(leaseMs)||leaseMs<100||leaseMs>30000)error('INVALID_NAMES','Invalid observer lease duration');
    const snapshot=new Map(tabs.map(t=>[tabKey({machine:t.machine,tabId:t.id??t.tabId}),t]));
    const {result}=await this.edit(d=>{
      const now=this.clock();if(d.lease&&d.lease.owner!==this.owner&&d.lease.expiresAt>now)return {owned:false,changed:[]};
      d.lease={owner:this.owner,expiresAt:now+leaseMs};const changed=[];
      for(const r of Object.values(d.origins)){
        if(!r.currentTab)continue;const live=snapshot.get(tabKey(r.currentTab));if(!live)continue;
        const value=live.name??'';
        if(live.named===false&&r.mode==='manual'){r.mode='auto';r.manualName=null;r.lastAutoName=null;r.revision++;changed.push(r.originId);}
        else if(live.named===true&&value&&value!==r.lastAutoName&&(r.mode!=='manual'||value!==r.manualName)){
          name(value);r.mode='manual';r.manualName=value;r.revision++;changed.push(r.originId);
        }
      }return {owned:true,changed};
    });return result;
  }
  async releaseLease(){return this.edit(d=>{if(d.lease?.owner===this.owner)d.lease=null;});}
  async backToAutomatic(originId){return (await this.edit(d=>{const r=d.origins[originId];if(!r)error('UNKNOWN_ORIGIN','Unknown work origin');r.mode='auto';r.manualName=null;r.lastAutoName=null;r.revision++;return clone(r);})).result;}
  async applyName(originId,desired,{getTabs,rename,manualTransfer=false}={}){
    name(desired);if(typeof getTabs!=='function'||typeof rename!=='function')error('INVALID_NAMES','Live tab snapshot and rename action are required');
    const before=await this.find({originId});if(!before?.currentTab||(!manualTransfer&&before.mode!=='auto'))return {applied:false,reason:'manual-or-missing'};
    const find=()=>getTabs().find(t=>tabKey({machine:t.machine,tabId:t.id??t.tabId})===tabKey(before.currentTab));
    const live=find();if(!live)return {applied:false,reason:'closed'};
    if(live.named&&live.name!==before.lastAutoName&&live.name!==before.manualName)return {applied:false,reason:'user-renamed'};
    const expectedName=live.name;
    const {result}=await this.edit(d=>{
      const r=d.origins[originId];if(!r||r.revision!==before.revision||tabKey(r.currentTab)!==tabKey(before.currentTab))return false;
      if(manualTransfer){if(r.mode!=='manual'||desired!==r.manualName)return false;}else{if(r.mode!=='auto')return false;r.lastAutoName=desired;}
      r.revision++;return true;
    });
    if(!result)return {applied:false,reason:'ownership-changed'};
    // No await between the final live guard and run(tab.rename).
    const latest=find();if(!latest||latest.name!==expectedName)return {applied:false,reason:'user-renamed'};
    rename({id:before.currentTab.tabId,name:desired});return {applied:true};
  }
}
export const observeNames=(store,...args)=>store.observeNames(...args);
export const transferToAcknowledgedTab=(store,...args)=>store.transferToAcknowledgedTab(...args);
