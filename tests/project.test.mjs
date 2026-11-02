import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPackage, checkPackage, bundleLayouts, publishablePath } from '../scripts/project.mjs';

const name = 'mission-control-fixture';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'src/mods', name);
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(root, 'src/shared'));
  await fs.writeFile(path.join(root, 'src/shared/message.js'), 'export const label = "A native fixture";\n');
  await fs.writeFile(path.join(source, 'main.js'), 'import {View,div} from "gpui-kit"; import {label} from "../../shared/message.js"; export default class Panel extends View { render(){ return div().child(label); } }\n');
  await fs.writeFile(path.join(source, 'mod.json'), JSON.stringify({ title: 'Fixture', place: 'none' }));
  return { root, source };
}

test('bundles shared source inside the single native entry and own helper', async t => {
  const { root, source } = await fixture(t);
  await fs.writeFile(path.join(source, 'backend.mjs'), 'import path from "node:path"; console.log(path.basename(process.argv[2]));\n');
  const result = await buildPackage(name, { root });
  const code = await fs.readFile(path.join(result.directory, 'main.js'), 'utf8');
  assert.match(code, /A native fixture/);
  assert.doesNotMatch(code, /from ["']\.\./);
  assert.match(code, /from "gpui-kit"/);
  const helper = spawnSync(process.execPath, [path.join(result.directory, 'backend.mjs'), '/tmp/example'], { encoding: 'utf8' });
  assert.equal(helper.status, 0);
  assert.equal(helper.stdout.trim(), 'example');
  assert.ok(result.manifest.artifacts['backend.mjs']);
  assert.ok(result.manifest.sources['src/shared/message.js']);
  assert.doesNotMatch(JSON.stringify(result.manifest), new RegExp(root));
  assert.equal(await fs.stat(path.join(root, name, 'layouts')).then(() => true, () => false), false);
});

test('rejects sibling source imports and keeps the prior good output on failure', async t => {
  const { root, source } = await fixture(t);
  const good = await buildPackage(name, { root });
  const bytes = await fs.readFile(path.join(good.directory, 'main.js'));
  const other = path.join(root, 'src/mods/mission-control-other');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'code.js'), 'export const secret = "other mod";');
  await fs.writeFile(path.join(source, 'main.js'), 'import {secret} from "../mission-control-other/code.js"; export default secret;');
  await assert.rejects(buildPackage(name, { root }), /outside this mod/);
  assert.deepEqual(await fs.readFile(path.join(good.directory, 'main.js')), bytes);
  assert.ok((await fs.readdir(path.join(root, name))).every(n => !n.startsWith('.build-')));
});

test('GPUI cannot accidentally bundle Node APIs or outside symlink imports', async t => {
  const { root, source } = await fixture(t);
  await fs.writeFile(path.join(source, 'main.js'), 'import fs from "node:fs"; export default fs;');
  await assert.rejects(buildPackage(name, { root }), /GPUI cannot import node:fs/);
  const outside = path.join(root, 'outside.js');
  await fs.writeFile(outside, 'export default 1;');
  await fs.symlink(outside, path.join(source, 'escape.js'));
  await fs.writeFile(path.join(source, 'main.js'), 'import n from "./escape.js"; export default n;');
  await assert.rejects(buildPackage(name, { root }), /outside this mod/);
});

test('assets carry provenance and unsafe or missing artwork cannot enter the package', async t => {
  const { root, source } = await fixture(t);
  await fs.mkdir(path.join(root, 'src/assets'));
  const file = path.join(root, 'src/assets/icons.json');
  const catalog = { more: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="1"/></svg>', source: 'Original fixture artwork', license: 'CC0-1.0' } };
  await fs.writeFile(file, JSON.stringify(catalog));
  const result = await buildPackage(name, { root });
  assert.match(await fs.readFile(path.join(result.directory, 'NOTICE.md'), 'utf8'), /CC0-1.0/);
  assert.match(await fs.readFile(path.join(result.directory, 'assets/more.svg'), 'utf8'), /<circle/);
  catalog.more.svg = '<svg><image href="https://example.invalid/pixel"/></svg>';
  await fs.writeFile(file, JSON.stringify(catalog));
  await assert.rejects(buildPackage(name, { root }), /Unsafe or malformed SVG/);
  delete catalog.more.license;
  await fs.writeFile(file, JSON.stringify(catalog));
  await assert.rejects(buildPackage(name, { root }), /provenance/);
  await fs.writeFile(path.join(source, 'mod.json'), JSON.stringify({ title: 'Fixture', build: { assets: ['absent'] } }));
  await assert.rejects(buildPackage(name, { root }), /provenance/);
});

test('a native checker rejection propagates as failure, not a successful package check', async t => {
  const { root } = await fixture(t);
  await assert.rejects(checkPackage(name, { root, checker: [process.execPath, '-e', 'process.stderr.write("fixture rejection");process.exit(17)', '--'] }), error => {
    assert.equal(error.exitCode, 17);
    assert.match(error.message, /fixture rejection/);
    return true;
  });
});

test('supports actual Herdr docking places and rejects overlay kinds used as docking places', async t => {
  const { root, source } = await fixture(t);
  await fs.writeFile(path.join(source, 'mod.json'), JSON.stringify({ title: 'Fixture', place: 'right', size: 320 }));
  const result = await buildPackage(name, { root });
  assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'mod.json'))).place, 'right');
  await fs.writeFile(path.join(source, 'mod.json'), JSON.stringify({ title: 'Fixture', place: 'dialog' }));
  await assert.rejects(buildPackage(name, { root }), /Invalid mod manifest/);
});

test('keeps dependency licenses across unnamed ESM subpackage markers', async t => {
  const { root, source } = await fixture(t);
  const dep = path.join(root, 'node_modules/fixture-dep');
  await fs.mkdir(path.join(dep, 'dist/esm'), { recursive: true });
  await fs.writeFile(path.join(dep, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0', license: 'MIT', type: 'module', main: './dist/esm/main.js' }));
  await fs.writeFile(path.join(dep, 'dist/esm/package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(dep, 'dist/esm/main.js'), 'export const value = 42;');
  await fs.writeFile(path.join(dep, 'LICENSE'), 'Fixture dependency license text');
  await fs.writeFile(path.join(source, 'backend.mjs'), 'import {value} from "fixture-dep"; console.log(value);');
  const result = await buildPackage(name, { root });
  assert.match(await fs.readFile(path.join(result.directory, 'NOTICE.md'), 'utf8'), /fixture-dep@1\.0\.0.*\nFixture dependency license text/);
});

test('layout bundle copies exact standalone bytes and installed Settings SVGs', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'src/layouts'));
  for (const view of ['mission-control', 'mission-control-classic']) {
    await fs.writeFile(path.join(root, `src/layouts/${view}.json`), JSON.stringify({ type: 'block', preview: `layouts/${view}.svg`, content: { mod: name } }));
    await fs.writeFile(path.join(root, `src/layouts/${view}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  }
  const result = await bundleLayouts({ root });
  assert.deepEqual(result.mods, [name]);
  for (const file of ['main.js', 'mod.json', 'NOTICE.md']) {
    assert.deepEqual(await fs.readFile(path.join(root, name, 'mods', name, file)), await fs.readFile(path.join(result.directory, 'mods', name, file)));
  }
  assert.ok(await fs.stat(path.join(result.directory, 'layouts/mission-control-classic.svg')));
  await fs.rm(path.join(root, 'src/layouts/mission-control.svg'));
  await assert.rejects(bundleLayouts({ root }), /ENOENT/);
  assert.ok(await fs.stat(path.join(result.directory, 'layouts/mission-control.svg')));
});

test('private state and browser artifacts are excluded without hiding distributable assets', () => {
  for (const file of ['.browse/sessions/a/frame.png', '.env', '.env.local', 'mods/a/auth.json', 'evidence/session-bindings.json', 'a/.DS_Store', 'sessions/x.jsonl', 'mission-control-jira/.build-123/previous/main.js', '.layout-build-123/previous/preview.png']) assert.equal(publishablePath(file), false, file);
  for (const file of ['mission-control/preview.png', 'mission-control-jira/mods/mission-control-jira/main.js', 'mission-control-jira/mods/mission-control-jira/assets/jira.svg', '.ulpi/plans/mission-control.json']) assert.equal(publishablePath(file), true, file);
});

test('a failed manifest commit restores the previous mod and preserves recovery artifacts', async t => {
  const { root, source } = await fixture(t);
  const good = await buildPackage(name, { root });
  const before = await fs.readFile(path.join(good.directory, 'main.js'));
  const manifest = path.join(root, name, 'build-manifest.json');
  await fs.rename(manifest, manifest + '.previous');
  await fs.mkdir(manifest);
  await fs.writeFile(path.join(source, 'main.js'), 'import {View,div} from "gpui-kit"; export default class Panel extends View { render(){ return div().child("new attempt"); } }');
  await assert.rejects(buildPackage(name, { root }), /recovery artifacts retained/);
  assert.deepEqual(await fs.readFile(path.join(good.directory, 'main.js')), before);
  assert.equal((await fs.stat(manifest)).isDirectory(), true);
  const recovery = (await fs.readdir(path.join(root, name))).find(n => n.startsWith('.build-'));
  assert.ok(recovery);
  assert.match(await fs.readFile(path.join(root, name, recovery, 'failed-output/main.js'), 'utf8'), /new attempt/);
});
