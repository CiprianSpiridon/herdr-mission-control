import test from 'node:test';
import assert from 'node:assert/strict';
import Mods,{actionsFor,matches,STATE_LABEL} from '../src/mods/mission-control-mods/main.js';
import {injectNative,context,trigger,findElement,Element} from './support/native-recording.mjs';

const ITEMS = [
  {key: 'mod:foo', kind: 'mod', name: 'foo', state: 'update', origin: 'user', source: {fullName: 'acme/foo', path: ''}, update: {subject: 'Faster', time: Date.now() - 60000, changed: 2, added: 1, removed: 0}, usedBy: [], preview: 'mission-control/mods/cache/previews/mod-foo.png'},
  {key: 'mod:bar', kind: 'mod', name: 'bar', state: 'current', origin: 'user', source: {fullName: 'acme/bar', path: 'pkg'}, usedBy: ['lay']},
  {key: 'mod:baz', kind: 'mod', name: 'baz', state: 'ambiguous', origin: 'user', candidates: [{fullName: 'a/baz', path: '', url: 'https://github.com/a/baz', defaultBranch: 'main', exact: false}], usedBy: []},
  {key: 'mod:zzz', kind: 'mod', name: 'zzz', state: 'untracked', origin: 'user', usedBy: []},
  {key: 'mod:off', kind: 'mod', name: 'off', state: 'disabled', origin: 'user', disabled: true, usedBy: []},
  {key: 'layout:lay', kind: 'layout', name: 'lay', state: 'edited', origin: 'user', source: {fullName: 'acme/lay', path: ''}, usedBy: []},
  {key: 'mod:menu', kind: 'mod', name: 'menu', state: 'builtin', origin: 'builtin', usedBy: []},
  {key: 'mod:mission-control-agents', kind: 'mod', name: 'mission-control-agents', state: 'installer', origin: 'installer', installerPackage: 'mission-control', usedBy: ['mission-control']},
  {key: 'mod:mission-control-mods', kind: 'mod', name: 'mission-control-mods', state: 'self', origin: 'self', usedBy: []}
];

function walk(node, fn) { if (node instanceof Element) { fn(node);node.nodes.forEach(c => walk(c, fn)); } }
const has = (tree, id) => { let found = false;walk(tree, el => { if (el.semanticId === id) found = true; });return found; };
const text = tree => { const out = [];walk(tree, el => { for (const v of el.nodes) if (typeof v === 'string') out.push(v); });return out.join(' | '); };

function mount(t, {respond}) {
  const calls = [];
  injectNative({props: {hideHeader: true}, appHome: '/fixture/app', shared: {layout: 'main'},
    exec: async (cmd, args) => {
      if (cmd === 'open') { calls.push({op: 'open', dir: args[0]});return {code: 0, stdout: ''}; }
      const request = JSON.parse(args[1]);calls.push(request);
      const out = await respond(request);return {code: 0, stdout: JSON.stringify(out)};
    }});
  const cx = context(), view = new Mods();
  const tasks = [];cx.spawn = fn => { const p = Promise.resolve().then(() => fn(cx));tasks.push(p);return {cancel() {}, is_done: () => false}; };
  cx.timer = {every: () => ({cancel() {}})};
  view.init({}, cx);t.after(() => view.close());
  const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.all(tasks.splice(0));await new Promise(r => setImmediate(r)); } };
  return {view, cx, calls, settle, render: () => view.render(cx)};
}
const listing = (extra = {}) => ({v: 1, ok: true, list: ITEMS, removed: [{id: 'mod:old@1', kind: 'mod', name: 'old', at: 1, restoreUntil: 2}], ...extra});

test('each state offers exactly its actions; filters and search narrow the list', () => {
  const by = Object.fromEntries(ITEMS.map(i => [i.name, actionsFor(i)]));
  assert.deepEqual(by.foo, ['update', 'disable', 'uninstall']);assert.deepEqual(by.baz, ['choose', 'disable', 'uninstall']);assert.deepEqual(by.zzz, ['link', 'disable', 'uninstall']);
  assert.deepEqual(by.off, ['enable', 'uninstall']);assert.deepEqual(by.bar, ['disable', 'uninstall']);
  for (const n of ['menu', 'mission-control-agents', 'mission-control-mods']) assert.deepEqual(by[n], [], n + ' is read-only');
  assert.deepEqual(ITEMS.filter(i => matches(i, 'updates', '')).map(i => i.name), ['foo']);
  assert.deepEqual(ITEMS.filter(i => matches(i, 'all', 'acme/b')).map(i => i.name), ['bar']);
  for (const state of new Set(ITEMS.map(i => i.state))) assert.ok(STATE_LABEL[state], state);
});

test('opening recovers first, lists every section with thumbnails, and offers Update all', async t => {
  const m = mount(t, {respond: r => r.op === 'recover' ? {v: 1, ok: true, recovered: {recovered: false}} : listing({checkedAt: Date.now()})});
  await m.settle();
  assert.deepEqual(m.calls.map(c => c.op), ['recover', 'inventory', 'check'], 'recovery runs before anything is listed');
  assert.equal(m.calls[1].activeLayout, 'main');
  const tree = m.render(), all = text(tree);
  for (const s of ['Updates', 'Layouts', 'Mods', 'Disabled', 'Built into Herdr', 'Removed (restorable for 30 days)']) assert.match(all, new RegExp(s.replace(/[()]/g, '\\$&')));
  assert.ok(has(tree, 'mods-update-all'));assert.ok(has(tree, 'update-mod:foo'));assert.equal(has(tree, 'disable-mod:menu'), false, 'built-in items have no actions');
  let images = [];walk(tree, el => { if (el.kind === 'image') images.push(el.value); });assert.deepEqual(images, ['mission-control/mods/cache/previews/mod-foo.png']);
});

test('Update shows the review before anything is written, and Apply commits', async t => {
  const m = mount(t, {respond: r => r.op === 'prepare' ? {v: 1, ok: true, prepared: {ok: true, state: 'ready', review: {subject: 'Faster', changed: ['main.js'], removed: [], keptEdited: [], access: {hosts: ['api.example.com'], programs: [], files: false}, keys: {add: [{section: 'global', key: 'ctrl-f', action: 'foo.open'}], remove: [], clash: []}}}} : r.op === 'commit' ? {v: 1, ok: true, committed: {ok: true}} : listing()});
  await m.settle();
  trigger(m.render(), 'update-mod:foo', 'on_click', {}, m.cx);await m.settle();
  assert.equal(m.calls.filter(c => c.op === 'commit').length, 0, 'nothing is committed before the review');
  const review = text(m.render());assert.match(review, /Changed or added/);assert.match(review, /reaches api\.example\.com/);assert.match(review, /global ctrl-f → foo\.open/);
  trigger(m.render(), 'review-apply', 'on_click', {}, m.cx);await m.settle();
  assert.deepEqual(m.calls.filter(c => c.op === 'commit').map(c => c.key), ['mod:foo']);assert.match(text(m.render()), /foo updated/);
});

test('a conflict offers Keep mine, Take theirs and Open the merged files', async t => {
  let prepared = 0;
  const m = mount(t, {respond: r => r.op === 'prepare' ? (prepared++ === 0
    ? {v: 1, ok: true, prepared: {ok: false, state: 'conflict', conflicts: [{file: 'main.js', binary: false}], conflictDir: '/fixture/app/mission-control/mods/conflicts/mod-foo', review: {}}}
    : {v: 1, ok: true, prepared: {ok: true, state: 'ready', review: {changed: ['main.js']}}}) : listing()});
  await m.settle();trigger(m.render(), 'update-mod:foo', 'on_click', {}, m.cx);await m.settle();
  assert.match(text(m.render()), /Nothing was written/);
  trigger(m.render(), 'conflict-open', 'on_click', {}, m.cx);assert.deepEqual(m.calls.at(-1), {op: 'open', dir: '/fixture/app/mission-control/mods/conflicts/mod-foo'});
  trigger(m.render(), 'conflict-theirs', 'on_click', {}, m.cx);await m.settle();
  assert.deepEqual(m.calls.filter(c => c.op === 'prepare').at(-1).resolutions, {'main.js': 'theirs'});assert.ok(has(m.render(), 'review-apply'));
});

test('a mod a layout uses asks for confirmation naming it; uninstall states the 30-day deletion', async t => {
  const m = mount(t, {respond: r => r.op === 'disable' ? (r.confirm ? {v: 1, ok: true, result: {ok: true, state: 'disabled'}} : {v: 1, ok: true, result: {needsConfirm: true, layouts: ['lay']}}) : listing()});
  await m.settle();
  trigger(m.render(), 'disable-mod:bar', 'on_click', {}, m.cx);await m.settle();
  assert.match(text(m.render()), /Used by lay\. Disable bar anyway\?/);
  trigger(m.render(), 'confirm-yes-mod:bar', 'on_click', {}, m.cx);await m.settle();
  assert.equal(m.calls.filter(c => c.op === 'disable').at(-1).confirm, true);
  trigger(m.render(), 'uninstall-mod:foo', 'on_click', {}, m.cx);
  assert.match(text(m.render()), /restored for 30 days, then it is deleted/);
});

test('a helper error keeps the last list and shows the reason', async t => {
  let fail = false;
  const m = mount(t, {respond: r => fail ? {v: 1, ok: false, code: 'BUILT_IN', message: 'menu is built into Herdr.'} : listing()});
  await m.settle();fail = true;
  trigger(m.render(), 'disable-mod:bar', 'on_click', {}, m.cx);await m.settle();
  const all = text(m.render());assert.match(all, /built into Herdr/);assert.ok(has(m.render(), 'row-mod:bar'), 'the list stays');
});
