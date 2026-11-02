import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const checkOnly = process.argv.includes('--check');
const plans = fs.readdirSync(dir).filter(f => /^mission-control.*\.json$/.test(f)).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
if (!plans.length) throw new Error('No canonical plan files found');
const tasks = new Map();
for (const p of plans) for (const t of p.tasks) {
  if (tasks.has(t.id)) throw new Error(`Duplicate task ${t.id}`);
  tasks.set(t.id, { p, t });
}
const chains = new Map();
function chain(id, visiting = new Set()) {
  if (chains.has(id)) return chains.get(id);
  if (visiting.has(id)) throw new Error(`Cycle at ${id}`);
  if (!tasks.has(id)) throw new Error(`Unknown dependency ${id}`);
  visiting.add(id);
  const t = tasks.get(id).t;
  const parents = t.dependsOn.map(d => chain(d, new Set(visiting)));
  const longest = parents.sort((a,b) => b.length - a.length)[0] || [];
  const result = [...longest, id];
  chains.set(id, result);
  return result;
}
for (const id of tasks.keys()) chain(id);
const bullets = a => a.map(s => `- ${s}`).join('\n');
const escape = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n${rows.map(r=>`| ${r.map(escape).join(' | ')} |`).join('\n')}`;
function render(p) {
  const ext = Object.entries(p.externalDependencies).map(([id, d])=>`- ${id}: [${d.plan}](${d.plan}.md) — ${d.provides}`);
  const diagram = ['```mermaid','flowchart TD'];
  for (const [id,d] of Object.entries(p.externalDependencies)) diagram.push(`  ${id.replaceAll('-','_')}["${id}: ${d.provides.replaceAll('"',"'")}"]`);
  for (const t of p.tasks) {
    const id = t.id.replaceAll('-','_');
    diagram.push(`  ${id}["${t.id}: ${t.title.replaceAll('"',"'")}"]`);
    for (const dep of t.dependsOn) diagram.push(`  ${dep.replaceAll('-','_')} --> ${id}`);
  }
  diagram.push('```');
  const sections = [
    `# Plan: ${p.title}`,
    `## Overview\n\n${p.overview}\n\nMode: **${p.mode}**. Review default: **${p.reviewDefault}**. Status: **${p.status}**. Tasks: **${p.tasks.length}**.\n\nCanonical source: [${p.name}.json](${p.name}.json).`,
    `## Scope Challenge\n\n${p.scopeChallenge}`,
    `## Prerequisites\n\n${bullets(p.prerequisites)}${ext.length?'\n\nCross-plan prerequisites:\n\n'+ext.join('\n'):''}`,
    `## Non-Goals\n\n${bullets(p.nonGoals)}`,
    `## Contracts\n\n${bullets(p.contracts)}\n\n${diagram.join('\n')}`,
    `## Existing Code Leverage\n\n${table(['Observed path / reference','Classification','Use'],p.existingCodeLeverage.map(x=>[x.file,x.classification,x.use]))}`,
    `## Tasks\n\n${p.tasks.map(t=>[
      `### ${t.id}: ${t.title}`,t.description,
      `**Type:** ${t.type}  \n**Priority:** ${t.priority}  \n**Effort:** ${t.effort}  \n**Agent:** ${t.agent}  \n**Review:** ${t.review}  \n**Depends on:** ${t.dependsOn.join(', ') || 'None'}`,
      `**Acceptance Criteria:**\n\n${bullets(t.acceptanceCriteria)}`,
      `**Write scope:**\n\n${table(['File','Action','Role'],t.writeScope.map(x=>[x.file,t.filesToModify.includes(x.file)?'Modify existing source or prior task output':'Create',x.role]))}`,
      `**Validate:**\n\n\`\`\`sh\n${t.validateCommand}\n\`\`\``,
      t.generatedArtifacts?.length?`**Generated outputs (not authored source):**\n\n${bullets(t.generatedArtifacts)}`:''
    ].filter(Boolean).join('\n\n')).join('\n\n')}`,
    `## Failure Modes\n\n${table(['Failure','Containment / recovery'],p.failureModes)}`,
    `## Ship Cut\n\n${p.shipCut}`,
    `## Test Coverage Map\n\n${table(['Task','Paths','Gate'],p.testCoverageMap.map(x=>[x.task,x.paths.join(', '),`${x.type}: ${x.command}`]))}`,
    `## Execution Summary\n\n${table(['Metric','Derived value'],[['Tasks',p.tasks.length],['Local roots',p.executionSummary.localRoots.join(', ')||'None'],['Union DAG layers reached',p.executionSummary.layers.map(x=>x.layer).join(', ')],['Critical path including prerequisite plans',p.executionSummary.criticalPath.join(' → ')],['Cross-plan task dependencies',Object.keys(p.externalDependencies).length]])}\n\nLayers (global prerequisite depth, not arbitrary serial order):\n\n${p.executionSummary.layers.map(x=>`- Layer ${x.layer}: ${x.tasks.join(', ')}`).join('\n')}`,
    `## Task Dependencies\n\n\`\`\`json\n${JSON.stringify(p.dependencies,null,2)}\n\`\`\``,
  ];
  return sections.join('\n\n')+'\n';
}
for (const p of plans) {
  p.dependencies = Object.fromEntries(p.tasks.map(t=>[t.id,t.dependsOn]));
  const ids = [...new Set(p.tasks.flatMap(t=>t.dependsOn))].filter(id=>tasks.get(id).p.name !== p.name);
  p.externalDependencies = Object.fromEntries(ids.map(id=>[id,{plan:tasks.get(id).p.name,json:`.ulpi/plans/${tasks.get(id).p.name}.json`,provides:tasks.get(id).t.title}]));
  const criticalPath = p.tasks.map(t=>chain(t.id)).sort((a,b)=>b.length-a.length)[0] || [];
  const levels = new Map();
  for (const t of p.tasks) {
    const depth = chain(t.id).length;
    if (!levels.has(depth)) levels.set(depth, []);
    levels.get(depth).push(t.id);
  }
  p.executionSummary = {taskCount:p.tasks.length,localRoots:p.tasks.filter(t=>!t.dependsOn.some(d=>tasks.get(d).p.name===p.name)).map(t=>t.id),criticalPath,layers:[...levels].sort((a,b)=>a[0]-b[0]).map(([layer,tasks])=>({layer,tasks}))};
  const json = JSON.stringify(p,null,2)+'\n';
  const markdown = render(p);
  if (checkOnly) {
    if (fs.readFileSync(path.join(dir,p.name+'.json'),'utf8') !== json) throw new Error(`Derived JSON drift: ${p.name}; render first`);
    if (fs.readFileSync(path.join(dir,p.name+'.md'),'utf8') !== markdown) throw new Error(`Markdown drift: ${p.name}; render first`);
  } else {
    fs.writeFileSync(path.join(dir,p.name+'.json'),json);
    fs.writeFileSync(path.join(dir,p.name+'.md'),markdown);
  }
}
if (process.argv.includes('--check')) {
  const errors=[];
  const creators=new Map();
  for(const {p,t} of tasks.values()) for(const file of t.filesToCreate) {
    if(creators.has(file)) errors.push(`Multiple creators: ${file}`);
    creators.set(file,t.id);
    if(!fs.existsSync(path.join(root,path.dirname(file)))) errors.push(`Missing create parent: ${file}`);
  }
  const ancestors=(id)=>new Set(tasks.get(id).t.dependsOn.flatMap(d=>[d,...ancestors(d)]));
  const priorWriters=new Map();
  for(const {p,t} of [...tasks.values()].sort((a,b)=>chain(a.t.id).length-chain(b.t.id).length)) {
    const scope=t.writeScope.map(x=>x.file);
    if(scope.length<1||scope.length>3||new Set(scope).size!==scope.length) errors.push(`Invalid scope: ${t.id}`);
    if(t.acceptanceCriteria.length<2||t.acceptanceCriteria.length>3) errors.push(`Criteria count: ${t.id}`);
    if(!/^TASK-\d{3}$/.test(t.id)||!['P0','P1','P2','P3'].includes(t.priority)||!t.agent||!t.validateCommand||!t.review) errors.push(`Metadata: ${t.id}`);
    if(t.priority==='P0'&&t.dependsOn.length) errors.push(`P0 has dependency: ${t.id}`);
    const deps=ancestors(t.id);
    for(const file of t.filesToModify) {
      if(!fs.existsSync(path.join(root,file))&&!deps.has(creators.get(file))) errors.push(`No prior creator: ${t.id} ${file}`);
    }
    for(const file of scope){
      if(!t.filesToCreate.includes(file)&&!t.filesToModify.includes(file)) errors.push(`No action: ${t.id} ${file}`);
      const prior=priorWriters.get(file);
      if(prior&&!deps.has(prior)) errors.push(`Unordered writers: ${t.id} vs ${prior} for ${file}`);
      priorWriters.set(file,t.id);
    }
    const testFiles=[...t.validateCommand.matchAll(/tests\/[\w/-]+\.(?:test\.mjs|py)/g)].map(x=>x[0]);
    for(const file of testFiles) if(!scope.includes(file)&&!deps.has(creators.get(file))) errors.push(`Test not owned/prior: ${t.id} ${file}`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
}
const index=[
  '# Mission Control plan index',
  'One canonical plan per mod and one for the two-layout bundle. This is navigation and a derived dependency summary, not a master plan. Every plan requires founder review at its current JSON and Markdown SHA256 before implementation. Cross-plan references resolve globally unique TASK IDs through the JSON files listed here.',
  table(['Plan','Tasks','Scope / gate'],plans.map(p=>[`[${p.title}](${p.name}.md) · [JSON](${p.name}.json)`,p.tasks.length,p.status==='deferred-optional'?'Optional feasibility only; no shipped placeholder':p.name==='mission-control'?'Both layouts, shared foundations, native integration, installation and release':'Standalone mod, native check, recipe and actual preview'])),
  `Total: ${plans.length} plans; ${tasks.size} tasks; ${plans.filter(p=>p.status!=='deferred-optional').reduce((n,p)=>n+p.tasks.length,0)} required / active-scope tasks. The optional account gate is not a dependency of any required plan.`,
  '## Dependency resolution',
  'All dependsOn entries are globally unique TASK-NNN IDs. Each plan includes an externalDependencies map naming the owning companion JSON and capability for every direct cross-plan edge. The renderer validates the union for missing IDs, cycles, authored-file scope, observed create parents, previous creators, writer ordering and scoped-test ownership. JSON remains canonical; rerun `node .ulpi/plans/render.mjs --check` after edits.',
  '## Package rules',
  '- Standalone: `<name>/mods/<name>/`, `RECIPE.md`, native `preview.png`, optional `keys.json`; no `layouts/`. Public topic `herdr-mod`.\n- Layout: `mission-control/layouts/` with both layouts, required `mods/`, `RECIPE.md`, native `preview.png`. Public topic `herdr-layout`.\n- A single public repository may contain these complete folders and both topics. Runtime shared helpers are compiled inside each mod; no other mod code is read at runtime.',
  '## Current evidence boundary',
  'Implementation progress and exact validation receipts are recorded in `.ulpi/execution.json`. Existing source, standalone native packages and fixture evidence do not prove integrated layout behavior, live authenticated provider readings, installation or publication. A reopened task has no scheduling completion until replacement validation passes. Review reports live under evidence/reviews/ and must include hashes of both plan artifacts. Never treat task count or plan approval as implementation proof.',
];
if (!checkOnly) fs.writeFileSync(path.join(dir,'INDEX.md'),index.join('\n\n')+'\n');
console.log(JSON.stringify({plans:plans.length,tasks:tasks.size,checks:process.argv.includes('--check')?'passed':'not requested',sha256:Object.fromEntries(plans.map(p=>[p.name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,p.name+'.json'))).digest('hex')]))},null,2));
