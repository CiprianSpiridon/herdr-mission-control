import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_MODULES = new Set(['gpui-kit', 'gpui-base', 'herdr']);
const NAME = /^mission-control-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = async file => fs.access(file).then(() => true, () => false);
const inside = (file, parent) => file === parent || file.startsWith(parent + path.sep);
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

export function publishablePath(file) {
  const parts = file.replaceAll('\\', '/').split('/');
  return !parts.some(p => ['.browse', '.harness', 'node_modules', '.git', '.DS_Store'].includes(p) || p.startsWith('.build-') || p.startsWith('.layout-build-')
    || p === '.env' || p.startsWith('.env.') || /^(?:auth|credentials|session-bindings|launches|closed|shared)\.json$/.test(p)
    || /\.(?:jsonl|sqlite(?:-shm|-wal)?|db|log|tmp)$/.test(p));
}

function packageName(name) {
  if (!NAME.test(name)) throw new Error(`Invalid mod package name: ${name}`);
  return name;
}

async function json(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function filesBelow(dir) {
  const out = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks cannot enter a package: ${file}`);
    if (entry.isDirectory()) out.push(...await filesBelow(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function nativeBoundary(root, source) {
  return {
    name: 'native-boundary',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (NATIVE_MODULES.has(args.path)) return { path: args.path, external: true };
        if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !path.isAbsolute(args.path)) {
          throw new Error(`GPUI cannot import ${args.path}; use an out-of-process helper`);
        }
        const requested = path.resolve(args.resolveDir || root, args.path);
        const resolved = await fs.realpath(requested);
        if (!inside(resolved, source) && !inside(resolved, path.join(root, 'src/shared'))) {
          throw new Error(`Import outside this mod and shared build source: ${args.path}`);
        }
        return { path: resolved };
      });
    },
  };
}

async function writeAssets(root, target, selection) {
  const catalogFile = path.join(root, 'src/assets/icons.json');
  if (!await exists(catalogFile)) {
    if (selection?.length) throw new Error('Declared icon catalog is missing');
    return [];
  }
  const catalog = await json(catalogFile);
  const selected = selection ?? Object.keys(catalog);
  const notices = [];
  for (const key of selected) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) throw new Error(`Invalid icon key: ${key}`);
    const icon = catalog[key];
    if (!icon || typeof icon.svg !== 'string' || !icon.source || !icon.license) throw new Error(`Icon lacks artwork/provenance: ${key}`);
    if (!/^\s*<svg[\s>]/.test(icon.svg) || !/<\/svg>\s*$/.test(icon.svg)
      || /<script|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(icon.svg)) throw new Error(`Unsafe or malformed SVG: ${key}`);
    const dir = path.join(target, 'assets');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${key}.svg`), icon.svg + '\n');
    notices.push(`${key}: ${icon.source}; ${icon.license}${icon.notice ? '\n' + icon.notice : ''}`);
  }
  return notices;
}

async function composeCollector(root, target) {
  const common = path.join(root, 'src/shared');
  const names = ['collector.py', 'provider_codex.py', 'provider_claude.py', 'provider_grok.py'];
  const chunks = [];
  for (const name of names) chunks.push(await fs.readFile(path.join(common, name), 'utf8'));
  const code = chunks.join('\n\n') + '\n\nif __name__ == "__main__":\n    collector_main({"codex": collect_codex, "claude": collect_claude, "grok": collect_grok})\n';
  if (Buffer.byteLength(code) > 65536) throw new Error('Collector exceeds the 64 KiB remote argv budget');
  await fs.writeFile(path.join(target, 'collector.py'), code);
  return names.map(name => path.join(common, name));
}

async function dependencyNotices(root, inputs) {
  const notices = [];
  const seen = new Set();
  for (const file of inputs) {
    let at = path.dirname(path.resolve(root, file));
    while (inside(at, root) && at !== root) {
      if (await exists(path.join(at, 'package.json'))) {
        const pkg = await json(path.join(at, 'package.json'));
        if (!pkg.name || !pkg.version) { at = path.dirname(at); continue; }
        if (at.includes(`${path.sep}node_modules${path.sep}`) && !seen.has(at)) {
          seen.add(at);
          let license = '';
          for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
            if (await exists(path.join(at, candidate))) { license = await fs.readFile(path.join(at, candidate), 'utf8'); break; }
          }
          if (!license.trim()) throw new Error(`Bundled dependency has no located license text: ${pkg.name}`);
          notices.push(`${pkg.name}@${pkg.version} (${pkg.license ?? 'see license'})\n${license.trim()}`);
        }
        break;
      }
      at = path.dirname(at);
    }
  }
  return notices;
}

export async function buildPackage(name, { root = PROJECT_ROOT } = {}) {
  packageName(name);
  root = await fs.realpath(root);
  if ((await fs.lstat(path.join(root, 'src/mods', name))).isSymbolicLink()) throw new Error('A mod source folder cannot be a symlink');
  const source = await fs.realpath(path.join(root, 'src/mods', name));
  const entry = path.join(source, 'main.js');
  if (!await exists(entry)) throw new Error(`No native entry point: src/mods/${name}/main.js`);
  const manifestFile = path.join(source, 'mod.json');
  const manifest = await json(manifestFile);
  if (typeof manifest.title !== 'string' || !manifest.title.trim() || !['none', 'left', 'right', 'top', 'bottom'].includes(manifest.place ?? 'none')) throw new Error(`Invalid mod manifest: ${name}`);
  const { build: spec = {}, ...nativeManifest } = manifest;
  const packageRoot = path.join(root, name);
  await fs.mkdir(packageRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(packageRoot, '.build-'));
  const target = path.join(packageRoot, 'mods', name);
  const backup = path.join(stage, 'previous');
  const stagedMod = path.join(stage, name);
  await fs.mkdir(stagedMod);
  let moved = false;
  let installed = false;
  let retainRecovery = false;
  try {
    const native = await build({ entryPoints: [entry], bundle: true, platform: 'neutral', format: 'esm', target: 'es2022',
      charset: 'utf8', legalComments: 'inline', metafile: true, logLevel: 'silent', outfile: path.join(stagedMod, 'main.js'),
      plugins: [nativeBoundary(root, source)], absWorkingDir: root });
    const inputs = Object.keys(native.metafile.inputs);
    if (spec.backend !== undefined || await exists(path.join(source, 'backend.mjs'))) {
      const backendEntry = path.resolve(source, spec.backend ?? 'backend.mjs');
      if (!inside(await fs.realpath(backendEntry), source)) throw new Error('Backend entry escapes its own source folder');
      const helper = await build({ entryPoints: [backendEntry], bundle: true, platform: 'node', format: 'esm', target: 'node22',
        charset: 'utf8', legalComments: 'inline', metafile: true, logLevel: 'silent', outfile: path.join(stagedMod, 'backend.mjs'),
        banner: { js: 'import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);' }, absWorkingDir: root });
      inputs.push(...Object.keys(helper.metafile.inputs));
    }
    for (const input of inputs) {
      const resolved = await fs.realpath(path.resolve(root, input));
      if (![source, path.join(root, 'src/shared'), path.join(root, 'node_modules')].some(parent => inside(resolved, parent))) {
        throw new Error(`Bundled source escapes this mod, shared source and locked dependencies: ${input}`);
      }
    }
    if (spec.collector) inputs.push(...await composeCollector(root, stagedMod));
    const notices = await writeAssets(root, stagedMod, spec.assets);
    notices.push(...await dependencyNotices(root, inputs));
    await fs.writeFile(path.join(stagedMod, 'mod.json'), JSON.stringify(nativeManifest, null, 2) + '\n');
    await fs.writeFile(path.join(stagedMod, 'NOTICE.md'), '# Included artwork and code\n\n' + (notices.join('\n\n---\n\n') || 'No third-party artwork or code is bundled in this mod.') + '\n');
    const artifacts = {};
    for (const file of await filesBelow(stagedMod)) artifacts[relative(stagedMod, file)] = hash(await fs.readFile(file));
    const provenance = {};
    for (const file of [...new Set([...inputs.map(f => path.resolve(root, f)), manifestFile, path.join(root, 'src/assets/icons.json')])].sort()) {
      if (await exists(file)) provenance[relative(root, file)] = hash(await fs.readFile(file));
    }
    const buildManifest = { v: 1, name, artifacts, sources: provenance };
    await fs.writeFile(path.join(stage, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2) + '\n');
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await exists(target)) { await fs.rename(target, backup); moved = true; }
    try {
      await fs.rename(stagedMod, target);
      installed = true;
      await fs.rename(path.join(stage, 'build-manifest.json'), path.join(packageRoot, 'build-manifest.json'));
    } catch (error) {
      retainRecovery = moved || installed;
      try {
        if (installed && await exists(target)) await fs.rename(target, path.join(stage, 'failed-output'));
        if (moved && !await exists(target)) await fs.rename(backup, target);
      } catch (recoveryError) { error.message += `; recovery: ${recoveryError.message}`; }
      if (retainRecovery) error.message += `; recovery artifacts retained at ${stage}`;
      throw error;
    }
    return { name, directory: target, manifest: buildManifest };
  } finally {
    if (!retainRecovery) await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function checkPackage(name, { root = PROJECT_ROOT, checker = ['herdr-app'], env = process.env } = {}) {
  const result = await buildPackage(name, { root });
  const check = spawnSync(checker[0], [...checker.slice(1), 'check', result.directory], { encoding: 'utf8', env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (check.error || check.status !== 0) {
    const error = new Error(`Native check failed for ${name}: ${check.error?.message ?? check.stderr?.trim() ?? check.stdout?.trim()}`);
    error.exitCode = check.status || 1;
    throw error;
  }
  return { ...result, nativeCheck: check.stdout.trim() };
}

export async function bundleLayouts({ root = PROJECT_ROOT } = {}) {
  root = await fs.realpath(root);
  const destination = path.join(root, 'mission-control');
  const layouts = path.join(root, 'src/layouts');
  const required = new Set();
  const files = [];
  for (const name of ['mission-control', 'mission-control-classic']) {
    const layoutFile = path.join(layouts, `${name}.json`);
    const svgFile = path.join(layouts, `${name}.svg`);
    for (const file of [layoutFile, svgFile]) if (!inside(await fs.realpath(file), layouts)) throw new Error(`Layout source escapes its own folder: ${name}`);
    const tree = await json(layoutFile);
    if (tree.preview !== `layouts/${name}.svg`) throw new Error(`Layout preview path missing or wrong: ${name}`);
    const artwork = await fs.readFile(svgFile, 'utf8');
    if (!/^\s*<svg[\s>]/.test(artwork) || !/<\/svg>\s*$/.test(artwork) || /<!DOCTYPE|<script|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(artwork)) throw new Error(`Unsafe layout SVG: ${name}`);
    // These owned previews use the XML subset also accepted by the already
    // pinned JSX parser; malformed nesting fails before replacing a bundle.
    try { await transform(artwork, { loader: 'jsx', jsx: 'preserve', logLevel: 'silent' }); }
    catch { throw new Error(`Malformed layout SVG: ${name}`); }
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.mod === 'string' && value.mod.startsWith('mission-control-')) required.add(packageName(value.mod));
      for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
    };
    visit(tree);
    files.push(layoutFile, svgFile);
  }
  if (!required.size) throw new Error('Layout bundle contains no required custom mods');
  const stage = await fs.mkdtemp(path.join(root, '.layout-build-'));
  const old = path.join(stage, 'previous');
  let moved = false;
  let retainRecovery = false;
  try {
    for (const file of files) {
      await fs.mkdir(path.join(stage, 'next/layouts'), { recursive: true });
      await fs.copyFile(file, path.join(stage, 'next/layouts', path.basename(file)));
    }
    for (const name of [...required].sort()) {
      const built = await buildPackage(name, { root });
      await fs.cp(built.directory, path.join(stage, 'next/mods', name), { recursive: true });
    }
    for (const keep of ['RECIPE.md', 'preview.png', 'NOTICE.md']) {
      const file = path.join(destination, keep);
      if (await exists(file)) await fs.copyFile(file, path.join(stage, 'next', keep));
    }
    const manifest = {};
    for (const file of await filesBelow(path.join(stage, 'next'))) manifest[relative(path.join(stage, 'next'), file)] = hash(await fs.readFile(file));
    await fs.writeFile(path.join(stage, 'next/build-manifest.json'), JSON.stringify({ v: 1, name: 'mission-control', artifacts: manifest }, null, 2) + '\n');
    if (await exists(destination)) { await fs.rename(destination, old); moved = true; }
    try { await fs.rename(path.join(stage, 'next'), destination); }
    catch (error) {
      if (moved) {
        retainRecovery = true;
        if (!await exists(destination)) await fs.rename(old, destination);
        error.message += `; recovery artifacts retained at ${stage}`;
      }
      throw error;
    }
    return { directory: destination, mods: [...required].sort() };
  } finally { if (!retainRecovery) await fs.rm(stage, { recursive: true, force: true }); }
}

export async function inspectDocs(files, { root = PROJECT_ROOT } = {}) {
  if (!files.length) throw new Error('Pass the exact document paths to inspect');
  for (const file of files) {
    const target = path.resolve(root, file);
    if (!inside(target, root) || !publishablePath(file)) throw new Error(`Document path is outside the public scope: ${file}`);
    const bytes = await fs.readFile(target);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim() || text.includes('\ufffd')) throw new Error(`Empty or invalid UTF-8 document: ${file}`);
  }
  return { inspected: files };
}

async function main(args) {
  const [command, ...names] = args;
  if (command === 'bundle') return bundleLayouts();
  if (command === 'inspect-docs') return inspectDocs(names);
  if (!['build', 'check'].includes(command)) throw new Error('Usage: node scripts/project.mjs build|check <mod-name> | bundle | inspect-docs <paths...>');
  const targets = names.length ? names : (await fs.readdir(path.join(PROJECT_ROOT, 'src/mods'))).filter(name => NAME.test(name));
  if (!targets.length) throw new Error('No native mod sources are present');
  const results = [];
  for (const name of targets) results.push(await (command === 'check' ? checkPackage : buildPackage)(name));
  return results.map(r => ({ name: r.name, directory: relative(PROJECT_ROOT, r.directory), ...(r.nativeCheck ? { nativeCheck: r.nativeCheck } : {}) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
