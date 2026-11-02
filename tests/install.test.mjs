import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, rollback, formatDisclosure, verifyInstallReceipt, validateInstallReceipt, planInstall, readPackage, layoutReferences, analyzeKeys, terminalAddresses, pngInfo, removeOwned, InstallError } from '../scripts/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/install.mjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.lstat(file).then(() => true, () => false);

// A fake herdr-app: status/ls/check/do layout.switch/shot against a JSON state file. It never talks to a real window.
const STUB = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const file=process.env.HERDR_STUB_STATE,state=JSON.parse(fs.readFileSync(file,'utf8')),[cmd,...rest]=process.argv.slice(2),home=process.env.HERDR_APP_HOME;
state.calls.push({args:process.argv.slice(2),home});
const save=()=>fs.writeFileSync(file,JSON.stringify(state,null,2));
const out=(value,code=0)=>{save();process.stdout.write(typeof value==='string'?value+'\\n':JSON.stringify(value)+'\\n');process.exit(code);};
const png=(w,h,text)=>{const sig=Buffer.from('89504e470d0a1a0a','hex'),ihdr=Buffer.alloc(25);ihdr.writeUInt32BE(13,0);ihdr.write('IHDR',4,'latin1');ihdr.writeUInt32BE(w,8);ihdr.writeUInt32BE(h,12);ihdr[16]=8;ihdr[17]=6;const t=Buffer.from(text),c=Buffer.alloc(12+t.length);c.writeUInt32BE(t.length,0);c.write('tEXt',4,'latin1');t.copy(c,8);return Buffer.concat([sig,ihdr,c,Buffer.from('0000000049454e44ae426082','hex')]);};
if(cmd==='status')out({layout:state.layout,errors:state.errorsFor?.[state.layout]??state.errors,focus:{}});
if(cmd==='ls')out({spaces:[{id:'sp1',tabs:[{id:'tb1',terminals:(state.dropTerminalsFor===state.layout?[]:state.terminals).map(address=>({address}))}]}]});
if(cmd==='check'){const name=path.basename(rest[0]);if(name===state.failCheck){save();process.stderr.write('Error: '+name+' failed to render\\n');process.exit(1);}if(!fs.existsSync(path.join(rest[0],'main.js'))){save();process.stderr.write('no main.js\\n');process.exit(1);}if(!state.noGenerated){for(const f of ['jsconfig.json','gpui-kit.d.ts']){const t=path.join(rest[0],f);if(!fs.existsSync(t))fs.writeFileSync(t,fs.readFileSync(path.join(home,'mods/tabs',f)));}}out('ok '+name);}
if(cmd==='do'&&rest[0]==='layout.switch'){const {name}=JSON.parse(rest[1]);if(state.switchFails||!fs.existsSync(path.join(home,'layouts',name+'.json')))out({error:'no layout '+name},1);state.layout=name;out({});}
if(cmd==='shot'){fs.writeFileSync(rest[0],png(state.staticShot?800:800+state.layout.length,600,state.staticShot?'frame':state.layout));out(rest[0]);}
save();process.stderr.write('unknown command\\n');process.exit(2);
`;

const GENERATED_JSCONFIG = '{\n  "// why": ["Written once by gpui-shell, then yours"]\n}\n';
const GENERATED_DTS = '// Auto-generated — add `gpui-kit.d.ts` to your .gitignore.\ndeclare module "gpui-kit" {}\n';

async function stub(dir, initial = {}) {
  const bin = path.join(dir, 'herdr-app'), statePath = path.join(dir, 'stub-state.json');
  await fs.writeFile(bin, STUB, { mode: 0o755 });
  await fs.writeFile(statePath, JSON.stringify({ layout: 'main', errors: [], terminals: ['t1', 't2'], calls: [], ...initial }));
  const read = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
  const patch = async value => fs.writeFile(statePath, JSON.stringify({ ...await read(), ...value }));
  return { bin, statePath, read, patch, env: { ...process.env, HERDR_STUB_STATE: statePath, MISSION_CONTROL_HERDR_APP: bin } };
}

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}

const layoutTree = (name, mods) => JSON.stringify({ id: 'root', type: 'row', preview: `layouts/${name}.svg`, children: [{ id: 'top', type: 'block', content: { mod: 'tabs' } },
  ...mods.map(mod => ({ id: mod, type: 'block', content: { mod } }))] }, null, 2) + '\n';

async function fixture(t, { keys } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-install-'));
  t.after(async () => { await fs.chmod(path.join(base, 'home/layouts'), 0o755).catch(() => {}); await fs.rm(base, { recursive: true, force: true }); });
  const source = path.join(base, 'pkg/mission-control'), home = path.join(base, 'home');
  const installable = {
    'mods/mission-control-alpha/main.js': 'import {View,div} from "gpui-kit";\nimport {exec} from "herdr";\nconst r = exec("gh", ["api", "user"]);\nconst body = fetch("https://api.github.com/user");\nexport default class A extends View { render(){ return div(); } }\n',
    'mods/mission-control-alpha/mod.json': JSON.stringify({ title: 'Alpha', place: 'right', size: 320 }) + '\n',
    'mods/mission-control-alpha/assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'mods/mission-control-beta/main.js': 'import {View,div} from "gpui-kit";\nimport {readTextFile,home} from "herdr";\nconst sessions = readTextFile(home() + "/.claude/projects/x.jsonl");\nexport default class B extends View { render(){ return div(); } }\n',
    'mods/mission-control-beta/mod.json': JSON.stringify({ title: 'Beta', place: 'none' }) + '\n',
    'layouts/mission-control.json': layoutTree('mission-control', ['mission-control-alpha', 'mission-control-beta']),
    'layouts/mission-control.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n',
    'layouts/mission-control-classic.json': layoutTree('mission-control-classic', ['mission-control-beta']),
    'layouts/mission-control-classic.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>\n',
  };
  await writeFiles(source, { ...installable, 'RECIPE.md': '# Mission Control\n\n![Mission Control](preview.png)\n', 'preview.png': Buffer.from('89504e470d0a1a0a', 'hex'), 'NOTICE.md': 'notices\n',
    'build-manifest.json': JSON.stringify({ v: 1, name: 'mission-control', artifacts: Object.fromEntries(Object.entries(installable).map(([rel, text]) => [rel, sha(Buffer.from(text))])) }) + '\n',
    ...(keys ? { 'keys.json': JSON.stringify(keys) } : {}) });
  await writeFiles(home, {
    'layouts/main.json': '{"id":"root","type":"block","content":{"mod":"tabs"}}\n', 'layouts/.state/main.json': '{"clicks":1}\n', 'mods/tabs/main.js': 'shipped\n', 'mods/tabs/jsconfig.json': GENERATED_JSCONFIG, 'mods/tabs/gpui-kit.d.ts': GENERATED_DTS,
    'mods/my-own/main.js': 'personal mod\n', 'keys.json': JSON.stringify({ global: { 'ctrl-shift-t': 'tab.new' }, terminal: { 'ctrl-left': 'send:\u001bb' } }, null, 2) + '\n',
    'installed.json': JSON.stringify({ tabs: { 'main.js': 'x' }, 'layout:main': {} }) + '\n', 'settings.json': '{"zoom":1}\n', 'notes.txt': 'unrelated\n',
  });
  const app = await stub(base);
  const options = { source, appHome: home, herdrApp: app.bin, env: app.env, receiptPath: path.join(base, 'receipts/install.json'), shotDir: path.join(base, 'shots'),
    pollMs: 1, pollAttempts: 5, settleMs: 0, onDisclosure: () => {} };
  return { base, source, home, app, options, installable, receiptPath: options.receiptPath };
}

async function snapshot(root) {
  const out = {};
  const visit = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), rel = path.relative(root, file);
      if (entry.isDirectory()) { out[rel + '/'] = 'dir'; await visit(file); } else out[rel] = sha(await fs.readFile(file));
    }
  };
  await visit(root);
  return out;
}

const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 60000 });

test('pure helpers: references, key analysis, terminal addresses and PNG frames', () => {
  assert.deepEqual(layoutReferences({ terminal_menu: 'my-menu', children: [{ type: 'stack', header: 'tabs', children: [{ content: { mod: 'mission-control-a' } }] }, { header: 'mission-control-tabs', floating: [{ content: { mod: 'toast' } }] }] }),
    ['mission-control-a', 'mission-control-tabs', 'my-menu', 'toast']);
  const keys = analyzeKeys({ global: { 'ctrl-shift-m': 'layout.switch', 'ctrl-shift-t': 'tab.new' }, 'layout:mission-control': { 'ctrl-1': 'space.select:1' } }, { global: { 'ctrl-shift-t': 'tab.new', 'ctrl-shift-m': 'app.palette' } });
  assert.deepEqual(keys.conflicts, [{ section: 'global', key: 'ctrl-shift-m', action: 'layout.switch', current: 'app.palette' }]);
  assert.deepEqual(keys.present.map(k => k.key), ['ctrl-shift-t']);
  assert.deepEqual(keys.pending, [{ section: 'layout:mission-control', key: 'ctrl-1', action: 'space.select:1' }]);
  assert.deepEqual([...terminalAddresses({ spaces: [{ tabs: [{ terminals: [{ address: 't1' }, 't2'] }] }], focus: { terminal: 't3' } })].sort(), ['t1', 't2', 't3']);
  assert.equal(pngInfo(Buffer.from('not a png')), null);
  const frame = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(frame); frame.writeUInt32BE(1280, 16); frame.writeUInt32BE(760, 20);
  assert.deepEqual(pngInfo(frame), { width: 1280, height: 760 });
  frame.writeUInt32BE(0, 16); assert.equal(pngInfo(frame), null);
});

test('dry-run reads every file, discloses network/exec/history access and writes nothing', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.home);
  let disclosed = null;
  const result = await install({ ...f.options, dryRun: true, onDisclosure: plan => { disclosed = plan; } });
  assert.equal(result.ok, true);
  assert.equal(result.layout, 'mission-control', 'The layout named after the package is the one to show');
  assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.targets.map(target => target.path), [
    'mods/mission-control-alpha/assets/icon.svg', 'mods/mission-control-alpha/main.js', 'mods/mission-control-alpha/mod.json', 'mods/mission-control-beta/main.js', 'mods/mission-control-beta/mod.json',
    'layouts/mission-control-classic.svg', 'layouts/mission-control.svg', 'layouts/mission-control-classic.json', 'layouts/mission-control.json'], 'Mods first, previews next, layout files last; recipe, preview.png and notices stay out');
  assert.ok(result.targets.every(target => target.sha256 === sha(Buffer.from(f.installable[target.path]))));
  const alpha = disclosed.disclosure.find(mod => mod.name === 'mission-control-alpha'), beta = disclosed.disclosure.find(mod => mod.name === 'mission-control-beta');
  assert.deepEqual(alpha.network.origins, ['https://api.github.com']);
  assert.deepEqual(alpha.exec.programs, ['gh']);
  assert.equal(alpha.place, 'right');
  assert.deepEqual(beta.files.evidence, ['mods/mission-control-beta/main.js:3']);
  assert.deepEqual(beta.history.evidence, ['mods/mission-control-beta/main.js:3']);
  assert.deepEqual(await snapshot(f.home), before, 'Dry-run proves no file or folder was written');
  assert.deepEqual((await f.app.read()).calls, [], 'Dry-run never contacts the app');
  const run = cli(['--dry-run', '--source', f.source, '--app-home', f.home], f.app.env);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /mods\/mission-control-alpha: reaches the network \(URLs in code: https:\/\/api\.github\.com\); runs programs \(gh\); docks itself on the right/);
  assert.match(run.stdout, /mods\/mission-control-beta: reads\/writes files outside its folder .*reads agent session history/);
  assert.ok(run.stdout.indexOf('disclosure') < run.stdout.indexOf('"targets"'), 'The disclosure prints before the plan');
  assert.deepEqual(await snapshot(f.home), before);
});

test('existing mod, layout and shipped names are refused, never overwritten or renamed', async t => {
  const f = await fixture(t);
  await writeFiles(f.home, { 'mods/mission-control-alpha/main.js': 'the person\'s own mod\n', 'layouts/mission-control-classic.json': '{"mine":true}\n' });
  await fs.writeFile(path.join(f.home, 'installed.json'), JSON.stringify({ tabs: {}, 'mission-control-beta': {}, 'layout:main': {} }));
  const before = await snapshot(f.home);
  const dry = await install({ ...f.options, dryRun: true });
  assert.equal(dry.ok, false);
  assert.deepEqual(dry.refusals.map(r => [r.code, r.path, r.reason]).sort(), [
    ['COLLISION', 'layouts/mission-control-classic.json', 'exists'], ['COLLISION', 'mods/mission-control-alpha', 'exists'], ['COLLISION', 'mods/mission-control-beta', 'shipped']].sort());
  await assert.rejects(install(f.options), error => error instanceof InstallError && error.code === 'REFUSED' && error.exitCode === 3 && error.details.length === 3);
  assert.deepEqual(await snapshot(f.home), before);
  assert.equal(await exists(f.receiptPath), false, 'A refused install leaves no receipt');
  assert.deepEqual((await f.app.read()).calls, []);
  const run = cli(['--source', f.source, '--app-home', f.home, '--receipt', f.receiptPath, '--shot-dir', path.join(f.base, 'shots')], f.app.env);
  assert.equal(run.status, 3);
  assert.match(run.stdout, /REFUSED COLLISION/);
  assert.match(run.stderr, /^REFUSED: Install refused: COLLISION/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('a key the person already uses is a refusal; free package keys are reported, keys.json is never written', async t => {
  const conflict = await fixture(t, { keys: { global: { 'ctrl-shift-t': 'mission-control-tabs.new' } } });
  const keysBefore = await fs.readFile(path.join(conflict.home, 'keys.json'));
  const dry = await install({ ...conflict.options, dryRun: true });
  assert.deepEqual(dry.refusals, [{ code: 'KEY_CONFLICT', section: 'global', key: 'ctrl-shift-t' }]);
  await assert.rejects(install(conflict.options), error => error.code === 'REFUSED');
  assert.deepEqual(await fs.readFile(path.join(conflict.home, 'keys.json')), keysBefore);
  const free = await fixture(t, { keys: { 'layout:mission-control': { 'ctrl-shift-m': 'layout.switch:mission-control-classic' }, global: { 'ctrl-shift-t': 'tab.new' } } });
  const freeBefore = await fs.readFile(path.join(free.home, 'keys.json'));
  assert.match(formatDisclosure(await planInstall({ source: free.source, appHome: free.home })), /keys\.json: 1 binding\(s\) are NOT merged automatically/);
  const result = await install(free.options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.keys.pending, [{ section: 'layout:mission-control', key: 'ctrl-shift-m', action: 'layout.switch:mission-control-classic' }]);
  assert.deepEqual(result.keys.present.map(k => k.key), ['ctrl-shift-t']);
  assert.deepEqual(await fs.readFile(path.join(free.home, 'keys.json')), freeBefore, 'No key is replaced or merged automatically');
});

test('install adds only new names, checks each mod, switches the layout and leaves a verifiable receipt', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.home);
  const result = await install(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.previousLayout, 'main');
  const state = await f.app.read();
  assert.equal(state.layout, 'mission-control');
  const home = await fs.realpath(f.home);
  assert.ok(state.calls.every(call => call.home === home), 'Every app call targets the explicit app home');
  assert.deepEqual(state.calls.filter(call => call.args[0] === 'check').map(call => path.relative(home, call.args[1])), ['mods/mission-control-alpha', 'mods/mission-control-beta']);
  assert.deepEqual(state.calls.filter(call => call.args[0] === 'do').map(call => call.args.slice(1)), [['layout.switch', '{"name":"mission-control"}']]);
  const after = await snapshot(f.home);
  for (const [rel, digest] of Object.entries(before)) assert.equal(after[rel], digest, `Pre-existing ${rel} is untouched`);
  const added = Object.keys(after).filter(rel => !(rel in before) && !rel.endsWith('/')).sort();
  const generated = ['mods/mission-control-alpha/gpui-kit.d.ts', 'mods/mission-control-alpha/jsconfig.json', 'mods/mission-control-beta/gpui-kit.d.ts', 'mods/mission-control-beta/jsconfig.json'];
  assert.deepEqual(added, [...Object.keys(f.installable), ...generated].sort(), 'Only package layouts/mods (plus the checker\'s own editor files) were added');
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  validateInstallReceipt(receipt);
  assert.equal(receipt.state, 'installed');
  assert.deepEqual(receipt.createdDirectories, ['mods/mission-control-alpha', 'mods/mission-control-beta', 'mods/mission-control-alpha/assets']);
  assert.deepEqual(Object.keys(receipt.generated).sort(), generated, 'App-written editor files in owned folders are recorded by digest');
  assert.deepEqual(receipt.validation.previews.map(p => p.path), ['layouts/mission-control-classic.svg', 'layouts/mission-control.svg']);
  assert.deepEqual(receipt.validation.terminals, { before: 2, after: 2, missing: [] });
  assert.notEqual(receipt.validation.frames.before.sha256, receipt.validation.frames.after.sha256);
  assert.deepEqual(receipt.validation.previousLayoutIntegrity['layouts/main.json'].before, receipt.validation.previousLayoutIntegrity['layouts/main.json'].after);
  assert.match(receipt.rollbackCommand, /--rollback --receipt .+install\.json --app-home /);
  assert.deepEqual((await verifyInstallReceipt(f.receiptPath)).files, 9);
  const verified = cli(['--verify-receipt', f.receiptPath], f.app.env);
  assert.equal(verified.status, 0, verified.stderr);
  await fs.appendFile(path.join(f.home, 'mods/mission-control-beta/main.js'), '// edited\n');
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'INSTALLED_FILES_CHANGED');
  await fs.writeFile(path.join(f.home, 'mods/mission-control-beta/main.js'), f.installable['mods/mission-control-beta/main.js']);
  await fs.appendFile(path.join(f.source, 'layouts/mission-control.svg'), '\n');
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'SOURCE_CHANGED');
});

test('the CLI install needs an explicit app home and a free receipt', async t => {
  const f = await fixture(t);
  const none = cli(['--source', f.source, '--receipt', f.receiptPath], f.app.env);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /APP_HOME_REQUIRED/);
  const run = cli(['--source', f.source, '--app-home', f.home, '--receipt', f.receiptPath, '--shot-dir', path.join(f.base, 'shots')], f.app.env);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Mission Control install disclosure/);
  assert.equal(JSON.parse(run.stdout.slice(run.stdout.indexOf('\n{'))).state, 'installed');
  const other = path.join(f.base, 'home2');
  await writeFiles(other, { 'mods/tabs/main.js': 'shipped\n' });
  const otherBefore = await snapshot(other);
  await assert.rejects(install({ ...f.options, appHome: other }), error => error.code === 'RECEIPT_IN_USE');
  assert.deepEqual(await snapshot(other), otherBefore, 'The second home received nothing');
  await assert.rejects(install({ ...f.options, appHome: other, receiptPath: path.join(other, 'r.json') }), error => error.code === 'RECEIPT_REQUIRED');
});

test('a failed native mod check removes every owned addition before any layout switch', async t => {
  const f = await fixture(t);
  await f.app.patch({ failCheck: 'mission-control-beta' });
  const before = await snapshot(f.home);
  await assert.rejects(install(f.options), error => error.code === 'CHECK_FAILED' && /mission-control-beta failed to render/.test(error.message) && /rolled back \(9 removed, 0 kept/.test(error.message));
  assert.deepEqual(await snapshot(f.home), before, 'Home returns to its exact previous tree');
  const state = await f.app.read();
  assert.equal(state.layout, 'main');
  assert.equal(state.calls.some(call => call.args[0] === 'do'), false);
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, 'CHECK_FAILED');
  assert.equal(receipt.rollback.removed.length, 9);
  assert.deepEqual(receipt.rollback.keptDirectories, []);
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'NOT_INSTALLED');
  const cleanRetry = await install({ ...f.options, receiptPath: f.receiptPath, dryRun: true });
  assert.equal(cleanRetry.ok, true, 'A fully rolled-back failure leaves the names free again');
});

test('status errors, a lost terminal or an unchanged frame after switching restore the previous layout', async t => {
  for (const [patch, code] of [[{ errorsFor: { 'mission-control': [{ file: 'mods/mission-control-alpha', message: 'TypeError' }] } }, 'STATUS_ERRORS'],
    [{ dropTerminalsFor: 'mission-control' }, 'TERMINALS_LOST'], [{ staticShot: true }, 'FRAME_UNCHANGED']]) {
    const f = await fixture(t);
    await f.app.patch(patch);
    const before = await snapshot(f.home);
    await assert.rejects(install(f.options), error => error.code === code && /layout main restored/.test(error.message));
    const state = await f.app.read();
    assert.equal(state.layout, 'main', `${code}: the previous layout is shown again`);
    assert.deepEqual(state.calls.filter(call => call.args[0] === 'do').map(call => JSON.parse(call.args[2]).name), ['mission-control', 'main']);
    assert.deepEqual(await snapshot(f.home), before, `${code}: only owned additions were removed`);
    assert.equal(JSON.parse(await fs.readFile(f.receiptPath, 'utf8')).rollback.layout.restored, 'main');
  }
  const pre = await fixture(t);
  await pre.app.patch({ errors: [{ file: 'layouts/other.json', message: 'old unrelated error' }] });
  assert.equal((await install(pre.options)).ok, true, 'An unchanged pre-existing error unrelated to the package does not block install');
});

test('a partial copy failure removes only the owned files already added', { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  const before = await snapshot(f.home);
  await fs.chmod(path.join(f.home, 'layouts'), 0o555);
  await assert.rejects(install(f.options), error => error.code === 'COPY_FAILED' && /layouts\/mission-control-classic\.svg: EACCES/.test(error.message));
  await fs.chmod(path.join(f.home, 'layouts'), 0o755);
  assert.deepEqual(await snapshot(f.home), before);
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  assert.deepEqual(receipt.rollback.removed.sort(), Object.keys(f.installable).filter(rel => rel.startsWith('mods/')).sort());
  assert.equal(receipt.rollback.layout.reason, 'not-switched');
  assert.equal((await f.app.read()).calls.some(call => call.args[0] === 'check' || call.args[0] === 'do'), false);
});

test('rollback restores the previous layout and keeps edited, unrelated and personal files', async t => {
  const f = await fixture(t);
  await install(f.options);
  const keys = await fs.readFile(path.join(f.home, 'keys.json'));
  await fs.writeFile(path.join(f.home, 'mods/mission-control-alpha/main.js'), 'the person edited this\n');
  await writeFiles(f.home, { 'mods/mission-control-alpha/notes.txt': 'mine\n', 'layouts/personal.json': '{}\n' });
  const run = cli(['--rollback', '--receipt', f.receiptPath, '--app-home', f.home], f.app.env);
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await f.app.read()).layout, 'main');
  assert.equal(await fs.readFile(path.join(f.home, 'mods/mission-control-alpha/main.js'), 'utf8'), 'the person edited this\n');
  assert.equal(await fs.readFile(path.join(f.home, 'mods/mission-control-alpha/notes.txt'), 'utf8'), 'mine\n');
  assert.equal(await exists(path.join(f.home, 'layouts/personal.json')), true);
  for (const rel of ['mods/mission-control-beta', 'mods/mission-control-alpha/assets', 'mods/mission-control-alpha/mod.json', 'layouts/mission-control.json', 'layouts/mission-control-classic.svg']) {
    assert.equal(await exists(path.join(f.home, rel)), false, `${rel} was removed`);
  }
  for (const rel of ['layouts/main.json', 'layouts/.state/main.json', 'mods/tabs/main.js', 'mods/my-own/main.js', 'notes.txt', 'settings.json']) assert.equal(await exists(path.join(f.home, rel)), true);
  assert.deepEqual(await fs.readFile(path.join(f.home, 'keys.json')), keys);
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  assert.equal(receipt.state, 'rolled-back');
  assert.deepEqual(receipt.rollback.kept, [{ path: 'mods/mission-control-alpha/main.js', reason: 'modified' }]);
  assert.deepEqual(receipt.rollback.keptDirectories, [{ path: 'mods/mission-control-alpha', reason: 'not-empty' }]);
  assert.equal(receipt.rollback.layout.restored, 'main');
  const verify = cli(['--verify-receipt', f.receiptPath], f.app.env);
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /NOT_INSTALLED: Install receipt state is rolled-back/);
  assert.equal((await rollback({ receiptPath: f.receiptPath, herdrApp: f.app.bin, env: f.app.env })).alreadyRolledBack, true);
});

test('manual rollback leaves a layout the person switched to afterwards', async t => {
  const f = await fixture(t);
  await install(f.options);
  await f.app.patch({ layout: 'main' });
  await writeFiles(f.home, { 'layouts/elsewhere.json': '{}\n' });
  await f.app.patch({ layout: 'elsewhere' });
  await fs.appendFile(path.join(f.home, 'mods/mission-control-beta/jsconfig.json'), '\n');
  const result = await rollback({ receiptPath: f.receiptPath, appHome: f.home, herdrApp: f.app.bin, env: f.app.env, pollMs: 1, pollAttempts: 3 });
  assert.equal(result.rollback.layout.reason, 'installed-layout-not-shown');
  assert.deepEqual(result.rollback.kept, [{ path: 'mods/mission-control-beta/jsconfig.json', reason: 'app-file-edited' }], 'An app-written file the person edited is theirs');
  assert.deepEqual(result.rollback.removedGenerated.sort(), ['mods/mission-control-alpha/gpui-kit.d.ts', 'mods/mission-control-alpha/jsconfig.json', 'mods/mission-control-beta/gpui-kit.d.ts']);
  assert.equal(await exists(path.join(f.home, 'mods/mission-control-alpha')), false);
  assert.equal((await f.app.read()).layout, 'elsewhere');
  await assert.rejects(rollback({ receiptPath: f.receiptPath, appHome: f.base, herdrApp: f.app.bin, env: f.app.env }), error => error.code === 'APP_HOME_MISMATCH');
});

test('receipt verification fails clearly when missing, malformed, tampered or stale', async t => {
  const f = await fixture(t);
  const missing = cli(['--verify-receipt', path.join(f.base, 'nothing.json')], f.app.env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^MISSING_RECEIPT: No install receipt at .*nothing\.json; it is written only by a confirmed real install\./);
  await fs.writeFile(path.join(f.base, 'bad.json'), '{');
  assert.match(cli(['--verify-receipt', path.join(f.base, 'bad.json')], f.app.env).stderr, /INVALID_RECEIPT/);
  await install(f.options);
  const good = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  const write = value => fs.writeFile(f.receiptPath, JSON.stringify(value));
  await write({ ...good, owned: good.owned.map((file, i) => i ? file : { ...file, sha256: '0'.repeat(64) }) });
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'INVALID_RECEIPT');
  await write({ ...good, validation: { ...good.validation, checks: [...good.validation.checks, { name: 'x', ok: false }] } });
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'INVALID_RECEIPT');
  await write({ ...good, installerSha256: 'f'.repeat(64) });
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'STALE_RECEIPT');
  await write({ ...good, ok: false });
  await assert.rejects(verifyInstallReceipt(f.receiptPath), error => error.code === 'INVALID_RECEIPT');
  await write(good);
  assert.equal((await verifyInstallReceipt(f.receiptPath)).ok, true);
});

test('package integrity: unmanifested, changed, symlinked, preview-less or unresolved packages are refused', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'mods/mission-control-beta/extra.js'), 'export {};\n');
  await assert.rejects(readPackage(f.source), error => error.code === 'UNMANIFESTED_PACKAGE');
  await fs.rm(path.join(f.source, 'mods/mission-control-beta/extra.js'));
  await fs.appendFile(path.join(f.source, 'mods/mission-control-beta/main.js'), '\n');
  await assert.rejects(readPackage(f.source), error => error.code === 'MANIFEST_MISMATCH');
  await fs.writeFile(path.join(f.source, 'mods/mission-control-beta/main.js'), f.installable['mods/mission-control-beta/main.js']);
  await fs.symlink('/etc/hosts', path.join(f.source, 'mods/mission-control-beta/link'));
  await assert.rejects(readPackage(f.source), error => error.code === 'INVALID_PACKAGE' && /Symlinks/.test(error.message));
  await fs.rm(path.join(f.source, 'mods/mission-control-beta/link'));
  const manifest = JSON.parse(await fs.readFile(path.join(f.source, 'build-manifest.json'), 'utf8'));
  delete manifest.artifacts['layouts/mission-control-classic.svg'];
  await fs.rm(path.join(f.source, 'layouts/mission-control-classic.svg'));
  const tree = JSON.parse(f.installable['layouts/mission-control.json']);
  tree.children.push({ id: 'extra', type: 'block', content: { mod: 'not-installed' } });
  const text = JSON.stringify(tree);
  await fs.writeFile(path.join(f.source, 'layouts/mission-control.json'), text);
  manifest.artifacts['layouts/mission-control.json'] = sha(Buffer.from(text));
  await fs.writeFile(path.join(f.source, 'build-manifest.json'), JSON.stringify(manifest));
  const plan = await planInstall({ source: f.source, appHome: f.home });
  assert.deepEqual(plan.refusals.map(r => [r.code, r.layout]).sort(), [['MISSING_REFERENCE', 'mission-control'], ['PREVIEW_UNRESOLVED', 'mission-control-classic']]);
  await assert.rejects(planInstall({ source: path.join(f.base, 'absent'), appHome: f.home }), error => error.code === 'INVALID_PACKAGE');
  await assert.rejects(planInstall({ source: f.source, appHome: 'relative/home' }), error => error.code === 'APP_HOME_REQUIRED');
  await assert.rejects(planInstall({ source: f.source, appHome: f.source }), error => error.code === 'UNSAFE_APP_HOME');
});

test('removeOwned never deletes a changed file or a non-empty folder', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-owned-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, { 'mods/mission-control-x/a.js': 'a', 'mods/mission-control-x/b.js': 'changed' });
  const result = await removeOwned(dir, [{ path: 'mods/mission-control-x/a.js', sha256: sha(Buffer.from('a')) }, { path: 'mods/mission-control-x/b.js', sha256: sha(Buffer.from('b')) },
    { path: 'mods/mission-control-x/gone.js', sha256: sha(Buffer.from('c')) }], ['mods/mission-control-x']);
  assert.deepEqual(result, { removed: ['mods/mission-control-x/a.js'], kept: [{ path: 'mods/mission-control-x/b.js', reason: 'modified' }], removedDirectories: [], keptDirectories: [{ path: 'mods/mission-control-x', reason: 'not-empty' }], removedGenerated: [] });
});

test('the repository receipt check fails cleanly until a real confirmed install exists', { skip: await exists(path.join(ROOT, 'evidence/native/install.json')) }, () => {
  const run = cli(['--verify-receipt', path.join(ROOT, 'evidence/native/install.json')], process.env);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^MISSING_RECEIPT: /);
});
