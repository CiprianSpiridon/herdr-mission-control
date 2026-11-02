import { register } from 'node:module';

// Only tests opt into this resolver. Production bundles keep native externals.
const recording = new URL('./native-recording.mjs', import.meta.url).href;
const namespaces={
  'gpui-kit':['View','div','svg','image','list'],
  'gpui-base':['h_flex','v_flex','InputState','Input','TextareaState','Textarea','Button','Scrollbar'],
  herdr:['spaces','agents','panes','terminals','machines','focused','layout','layouts','props','settings','window','theme','home','appHome','shared','setShared','run','exec','hc','knownAgents','setAgentOrder','readTextFile','writeTextFile','openOverlay','closeOverlay','notify','nextCommand','pickFolder']
};
const modules=Object.fromEntries(Object.entries(namespaces).map(([name,exports])=>[name,'data:text/javascript,'+encodeURIComponent(`export {${exports.join(',')}} from ${JSON.stringify(recording)};`)]));
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    const modules=${JSON.stringify(modules)};
    if (Object.hasOwn(modules,specifier))
      return {url:modules[specifier],shortCircuit:true};
    return next(specifier,context);
  }
`)}`, import.meta.url);
