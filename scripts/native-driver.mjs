import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'scripts/native-driver.swift');
const BINARY = path.join(ROOT, '.harness/bin/native-driver');
const OWNERS = new Map();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const exists = file => fs.access(file).then(() => true, () => false);

function command(executable, args, { timeout = 20000 } = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const raw = (result.stderr || result.stdout || result.error?.message || 'Native command failed').trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch {}
    const error = new Error(parsed?.message || parsed?.error || raw.slice(0, 1200));
    error.code = parsed?.code || 'NATIVE_COMMAND';
    throw error;
  }
  return result.stdout.trim();
}

export async function ensureNativeDriver() {
  if (process.platform !== 'darwin') throw new Error('The PID-bound native input driver currently requires macOS.');
  const digest = sha(await fs.readFile(SOURCE));
  const marker = BINARY + '.sha256';
  if (await exists(BINARY) && await exists(marker) && (await fs.readFile(marker, 'utf8')).trim() === digest) return BINARY;
  await fs.mkdir(path.dirname(BINARY), { recursive: true });
  const output = BINARY + '.next';
  command('swiftc', ['-module-cache-path', path.join(ROOT, '.harness/swift-cache'), '-O', SOURCE, '-o', output], { timeout: 60000 });
  await fs.rename(output, BINARY);
  await fs.writeFile(marker, digest + '\n');
  return BINARY;
}

export async function resolveBridgePath() {
  const which = spawnSync('which', ['browse'], { encoding: 'utf8' });
  const browse = which.status === 0 ? await fs.realpath(which.stdout.trim()) : null;
  const candidates = [process.env.MISSION_CONTROL_BROWSE_AX, browse && path.join(path.dirname(browse), 'browse-ax'),
    '/opt/homebrew/lib/node_modules/@ulpi/browse/bin/browse-ax'].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) {
    const help = command(candidate, ['--help']);
    if (help.includes('--pid') && help.includes('tree') && help.includes('action')) return candidate;
  }
  throw new Error('The installed Browse PID-bound accessibility bridge is unavailable.');
}

function fingerprint(pid) {
  return command('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm=']).trim();
}

export function validateTarget(owner, current) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 1 || !owner.nonce || !owner.fingerprint) throw new Error('Unowned native target');
  if (!current || current.pid !== owner.pid || current.fingerprint !== owner.fingerprint || current.exited) throw new Error('Stale or mismatched native target');
  return owner;
}

export function registerOwnedProcess(child, kind) {
  if (!(child instanceof ChildProcess) || !child.pid || child.exitCode !== null || !['probe', 'herdr'].includes(kind)) throw new Error('Only a live task-owned child can be registered');
  if ((kind === 'probe' && child.spawnfile !== BINARY) || (kind === 'herdr' && path.basename(child.spawnfile) !== 'Herdr')) throw new Error('The child is not an owned native probe/Herdr executable');
  const owner = { pid: child.pid, nonce: crypto.randomUUID(), fingerprint: fingerprint(child.pid), kind, child };
  OWNERS.set(owner.nonce, owner);
  return owner;
}

export function socketOwners(endpoint) {
  if (typeof endpoint !== 'string' || !path.isAbsolute(endpoint) || endpoint.includes('\0')) throw new Error('An absolute Unix socket path is required');
  if (!statSync(endpoint).isSocket()) throw new Error('The private control endpoint is not a Unix socket');
  // Keep exact-path and all-owner matching, select Unix sockets and disable
  // network name/service resolution on every guarded native observation.
  return command('lsof', ['-nP', '-U', '-t', '-a', '--', endpoint]).split(/\s+/).filter(Boolean).map(Number);
}

export async function registerOwnedSocketProcess({ directory, socket, previousPids = [] }) {
  const root = await fs.realpath(directory);
  if (!/^\/private\/tmp\/mcqa-[A-Za-z0-9]+$/.test(root)) throw new Error('Detached ownership requires a task-created scratch directory');
  const stat = await fs.stat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Scratch directory ownership is unproven');
  const endpoint = await fs.realpath(socket);
  if (endpoint !== path.join(root, 'app/herdr-app.sock') || !(await fs.stat(endpoint)).isSocket()) throw new Error('A private Herdr control socket is required');
  const pids = socketOwners(endpoint);
  if (pids.length !== 1 || !Number.isInteger(pids[0]) || pids[0] <= 1 || previousPids.includes(pids[0])) throw new Error('Socket owner is not a newly created private process');
  const pid = pids[0];
  if (path.basename(command('ps', ['-p', String(pid), '-o', 'comm='])) !== 'Herdr') throw new Error('Private socket is not owned by Herdr');
  const started = Date.parse(command('ps', ['-p', String(pid), '-o', 'lstart=']));
  if (!Number.isFinite(started) || started < stat.birthtimeMs - 2000) throw new Error('Process predates its task-created directory');
  const owner = { pid, nonce: crypto.randomUUID(), fingerprint: fingerprint(pid), kind: 'herdr', child: null, socket: endpoint, directory: root };
  OWNERS.set(owner.nonce, owner);
  return owner;
}

// Helpers the verified app spawns can inherit its listener; a live descendant still belongs to the owned app.
function descendsFrom(pid, ancestor) {
  for (let current = pid, steps = 0; current > 1 && steps < 32; steps++) {
    const r = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(current)], { encoding: 'utf8', timeout: 5000 });
    current = Number(r.stdout.trim());
    if (current === ancestor) return true;
  }
  return false;
}

function verified(owner) {
  if (OWNERS.get(owner?.nonce) !== owner) throw new Error('Unowned native target');
  if (owner.socket) {
    // An exited holder owns nothing; a live descendant of the verified app belongs to it.
    const pids = socketOwners(owner.socket).filter(pid => pid === owner.pid || spawnSync('/bin/ps', ['-p', String(pid)], { timeout: 5000 }).status === 0 && !descendsFrom(pid, owner.pid));
    if (pids.length !== 1 || pids[0] !== owner.pid) throw new Error('Private socket ownership changed');
  }
  return validateTarget(owner, { pid: owner.pid, fingerprint: fingerprint(owner.pid), exited: owner.child ? owner.child.exitCode !== null : false });
}

export function ownedProcessAlive(owner) {
  if (OWNERS.get(owner?.nonce) !== owner) throw new Error('Unowned native process');
  const result = spawnSync('ps', ['-p', String(owner.pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8' });
  if (result.status === 1 && !result.stdout.trim()) return false;
  if (result.status !== 0 || result.stdout.trim() !== owner.fingerprint) throw new Error('Owned native process identity changed');
  return true;
}

export function terminateOwnedProcess(owner) {
  verified(owner);
  process.kill(owner.pid, 'SIGTERM');
}

export function pointInWindow(frame, rectangle, expectedSize) {
  const values = [frame?.x, frame?.y, frame?.width, frame?.height, rectangle?.x, rectangle?.y, rectangle?.width, rectangle?.height];
  if (!values.every(Number.isFinite) || frame.width <= 0 || frame.height <= 0 || rectangle.width <= 0 || rectangle.height <= 0) throw new Error('Invalid native window/control bounds');
  if (expectedSize && (Math.abs(frame.width - expectedSize.width) > 1 || Math.abs(frame.height - expectedSize.height) > 1)) throw new Error('Stale native window size');
  if (rectangle.x < 0 || rectangle.y < 0 || rectangle.x + rectangle.width > frame.width || rectangle.y + rectangle.height > frame.height) throw new Error('Control lies outside the owned window');
  return { x: frame.x + rectangle.x + rectangle.width / 2, y: frame.y + rectangle.y + rectangle.height / 2 };
}

export function selectInputWindow(windows,pid,windowId){
  if(!Array.isArray(windows)||!Number.isInteger(pid)||pid<=1||windows.some(window=>window.pid!==pid))throw new Error('Window list does not belong to the verified process');
  if(windowId!==undefined&&(!Number.isSafeInteger(windowId)||windowId<=0))throw new Error('Invalid owned window identity');
  const matches=windowId===undefined?windows:windows.filter(window=>window.id===windowId);
  if(matches.length!==1)throw new Error('A unique owned visible native window is required: '+JSON.stringify({windowId:windowId??null,windows:windows.map(w=>({id:w.id,x:Math.round(w.x),y:Math.round(w.y),width:Math.round(w.width),height:Math.round(w.height)}))}));return matches[0];
}

export class NativeDriver {
  constructor(owner) { this.owner = owner; this.actions = []; }

  async bridge(...args) {
    verified(this.owner);
    // browse-ax types into whatever app is in front; never type until the owned app is.
    if (['type', 'press'].includes(args[0])) command(await ensureNativeDriver(), ['focus', String(this.owner.pid)]);
    // Accessibility reads of a large native tree can take longer than 20 s; give them room before failing.
    const result = JSON.parse(command(await resolveBridgePath(), ['--pid', String(this.owner.pid), ...args], { timeout: 45000 }));
    // browse-ax can exit cleanly without writing a frame; capture the owned window by its ID instead.
    if (args[0] === 'screenshot' && args.length === 2 && !await exists(args[1])) {
      const { frame } = await this.pointerTarget({ x: 1, y: 1, width: 2, height: 2 });
      const capture = spawnSync('/usr/sbin/screencapture', ['-x', '-o', '-l' + frame.id, args[1]], { encoding: 'utf8', timeout: 20000 });
      if (!await exists(args[1])) throw new Error('The owned window could not be captured: ' + (capture.stderr || JSON.stringify(result)).trim().slice(0, 300));
      return { ...result, fallback: 'screencapture-window-id', windowId: frame.id };
    }
    return result;
  }

  async tree() { return this.bridge('tree'); }

  async bindWindow(windowId){
    if(!Number.isSafeInteger(windowId)||windowId<=0)throw new Error('Invalid owned window identity');
    const {frame}=await this.pointerTarget({x:1,y:1,width:2,height:2},{windowId});
    if(this.windowId!==windowId)this.actions.push({kind:'window-bind',pid:this.owner.pid,windowId});
    this.windowId=windowId;return frame;
  }

  async enableAccessibility() {
    verified(this.owner);
    const helper = await ensureNativeDriver();
    return JSON.parse(command(helper, ['accessibility', String(this.owner.pid)]));
  }

  async ocr(file, query = '') {
    verified(this.owner);
    const canonical = await fs.realpath(file);
    const permitted = path.join(ROOT, '.browse/sessions');
    if (!canonical.startsWith(permitted + '/mission-control-native-') || !canonical.endsWith('.png')) throw new Error('OCR requires a task-owned native screenshot');
    const bytes = await fs.readFile(canonical);
    if (bytes.length > 32 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid native PNG');
    const { helper, frame } = await this.pointerTarget({ x: 1, y: 1, width: 2, height: 2 });
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (Math.abs(width / frame.width - height / frame.height) > 0.01) throw new Error('Screenshot does not match the current owned window size');
    const result = JSON.parse(command(helper, ['ocr', canonical, query]));
    const convert = node => ({ ...node, frame: { x: node.bounds.x * frame.width, y: node.bounds.y * frame.height, width: node.bounds.width * frame.width, height: node.bounds.height * frame.height } });
    return { ...result, lines: result.lines.map(convert), matches: result.matches.map(convert), source: { path: path.relative(ROOT, canonical), sha256: sha(bytes), width, height }, window: frame };
  }

  async clickObservedText(observation, node) {
    if (!observation?.source?.sha256 || !observation.matches.includes(node) || node.confidence < 0.6) throw new Error('An unambiguous observed native text control is required');
    const file = path.join(ROOT, observation.source.path);
    if (sha(await fs.readFile(file)) !== observation.source.sha256) throw new Error('The native observation was replaced');
    const result = await this.click(node.frame, { expectedSize: observation.window });
    Object.assign(this.actions.at(-1), { control: node.text, observation: observation.source });
    return result;
  }

  async action(node, action = 'AXPress') {
    if (!Array.isArray(node?.path) || !node.path.every(n => Number.isInteger(n) && n >= 0) || !node.role) throw new Error('An inspected native control is required');
    const tree = await this.tree();
    const current = flattenTree(tree).find(n => JSON.stringify(n.path) === JSON.stringify(node.path));
    if (!current || current.role !== node.role || current.label !== node.label || !current.enabled) throw new Error('Stale native control');
    if (!current.actions?.includes(action)) throw new Error('The native control does not expose that action');
    const result = await this.bridge('action', JSON.stringify(node.path), action);
    this.actions.push({ kind: 'AX', action, pid: this.owner.pid, path: node.path, role: node.role });
    return result;
  }

  async press(key) {
    if (typeof key !== 'string' || !key || key.length > 80) throw new Error('Invalid native key');
    verified(this.owner);
    const result = JSON.parse(command(await ensureNativeDriver(), ['press', String(this.owner.pid), key]));
    this.actions.push({ kind: 'key', pid: this.owner.pid, key });
    return result;
  }

  async setValue(node, value) {
    if (typeof value !== 'string' || value.length > 16000 || !Array.isArray(node?.path) || !['AXTextField', 'AXTextArea', 'AXSearchField'].includes(node.role)) throw new Error('An inspected editable native control is required');
    const current = flattenTree(await this.tree()).find(n => JSON.stringify(n.path) === JSON.stringify(node.path));
    if (!current || current.role !== node.role || current.label !== node.label || !current.enabled) throw new Error('Stale editable native control');
    const result = await this.bridge('set-value', JSON.stringify(node.path), value);
    this.actions.push({ kind: 'AXValue', pid: this.owner.pid, path: node.path, role: node.role, characters: value.length });
    return result;
  }

  async pointerTarget(rectangle, { windowId, expectedSize, coordinateSpace = 'window' } = {}) {
    verified(this.owner);
    const helper = await ensureNativeDriver();
    const windows = JSON.parse(command(helper, ['windows', String(this.owner.pid)])).windows;
    const frame = selectInputWindow(windows,this.owner.pid,windowId??this.windowId);
    if (!['window', 'screen'].includes(coordinateSpace)) throw new Error('Unknown native coordinate space');
    const relative = coordinateSpace === 'screen' ? { ...rectangle, x: rectangle.x - frame.x, y: rectangle.y - frame.y } : rectangle;
    const point = pointInWindow(frame, relative, expectedSize);
    return { helper, frame, point };
  }

  async click(rectangle, { button = 'left', ...options } = {}) {
    if (!['left', 'right'].includes(button)) throw new Error('Unsupported native pointer button');
    const { helper, frame, point } = await this.pointerTarget(rectangle, options);
    let result;
    try { result = JSON.parse(command(helper, ['click', String(this.owner.pid), String(frame.id), String(point.x), String(point.y), button])); }
    catch (error) { error.diagnostics = { geometry: { frame, rectangle, point, coordinateSpace: options.coordinateSpace || 'window' } }; throw error; }
    this.actions.push({ kind: 'pointer', button, pid: this.owner.pid, windowId: frame.id, ...point });
    return result;
  }

  /** Bring the owned window to the front, clicking an inert owned point only if macOS refuses activation. */
  async activate(rectangle, options = {}) {
    const { helper, frame, point } = await this.pointerTarget(rectangle, options);
    const result = JSON.parse(command(helper, ['activate-click', String(this.owner.pid), String(frame.id), String(point.x), String(point.y)]));
    this.actions.push({ kind: 'activation', pid: this.owner.pid, windowId: frame.id, ...point });
    return result;
  }

  async hover(rectangle, options = {}) {
    const { helper, frame, point } = await this.pointerTarget(rectangle, options);
    const result = JSON.parse(command(helper, ['hover', String(this.owner.pid), String(frame.id), String(point.x), String(point.y)]));
    this.actions.push({ kind: 'hover', pid: this.owner.pid, windowId: frame.id, ...point });
    return result;
  }

  async drag(from, to, options = {}) {
    const { helper, frame, point } = await this.pointerTarget(from, options);
    const destination = options.coordinateSpace === 'screen' ? { ...to, x: to.x - frame.x, y: to.y - frame.y } : to;
    const end = pointInWindow(frame, destination, options.expectedSize);
    const result = JSON.parse(command(helper, ['drag', String(this.owner.pid), String(frame.id), String(point.x), String(point.y), String(end.x), String(end.y)]));
    this.actions.push({ kind: 'drag', pid: this.owner.pid, windowId: frame.id, from: point, to: end });
    return result;
  }

  async scroll(rectangle, deltaY, options = {}) {
    if (!Number.isInteger(deltaY) || deltaY === 0 || Math.abs(deltaY) > 2000) throw new Error('Invalid native scroll amount');
    const { helper, frame, point } = await this.pointerTarget(rectangle, options);
    const result = JSON.parse(command(helper, ['scroll', String(this.owner.pid), String(frame.id), String(point.x), String(point.y), String(deltaY)]));
    this.actions.push({ kind: 'scroll', pid: this.owner.pid, windowId: frame.id, deltaY });
    return result;
  }
}

export function flattenTree(value, result = []) {
  if (Array.isArray(value)) value.forEach(v => flattenTree(v, result));
  else if (value && typeof value === 'object') {
    if (value.role) result.push(value);
    for (const child of value.children ?? []) flattenTree(child, result);
    if (value.root) flattenTree(value.root, result);
    if (value.windows) flattenTree(value.windows, result);
  }
  return result;
}

async function waitFor(read, description, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${last ? ': ' + last.message : ''}`);
}

export async function probe() {
  const helper = await ensureNativeDriver();
  const bridge = await resolveBridgePath();
  const permissions = JSON.parse(command(helper, ['permissions']));
  const directory = await fs.mkdtemp(path.join(ROOT, '.browse/sessions/mission-control-native-probe-'));
  const stateFile = path.join(directory, 'state.json');
  const child = spawn(helper, ['probe-window', stateFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let probeStderr = '';
  child.stderr.on('data', bytes => { probeStderr = (probeStderr + bytes.toString()).slice(-2500); });
  const owner = registerOwnedProcess(child, 'probe');
  const driver = new NativeDriver(owner);
  try {
    const before = await waitFor(async () => JSON.parse(await fs.readFile(stateFile, 'utf8')), 'owned native probe window');
    const button = await waitFor(async () => flattenTree(await driver.tree()).find(node => node.role === 'AXButton' && node.label === 'Count 0'), 'probe accessibility button');
    await driver.action(button);
    let after = await waitFor(async () => { const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); return state.count === 1 ? state : null; }, 'actual native action result');
    if (permissions.postEvents) {
      await driver.bindWindow(after.windowId);
      await driver.press('1');
      await waitFor(async () => { const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); return state.events.some(e => e.type === 10 && e.characters === '1'); }, 'actual owned native keyboard delivery');
      const nodes = flattenTree(await driver.tree());
      const currentButton = nodes.find(node => node.role === 'AXButton' && node.label === 'Count 1');
      if (!currentButton?.frame) throw new Error('The probe control lacks verified pointer geometry');
      await driver.click(currentButton.frame, { windowId: after.windowId, coordinateSpace: 'screen' });
      after = await waitFor(async () => { const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); return state.count === 2 ? state : null; }, 'actual native pointer result');
      const options = { windowId: after.windowId, coordinateSpace: 'screen' };
      await driver.click(currentButton.frame, { ...options, button: 'right' });
      await driver.drag(currentButton.frame, { ...currentButton.frame, x: currentButton.frame.x + 20 }, options);
      await driver.scroll(currentButton.frame, -120, options);
      after = await waitFor(async () => {
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        return state.events.some(e => e.type === 3 && e.button === 1) && state.events.some(e => e.type === 6) && state.events.some(e => e.type === 22 && e.deltaY !== 0) ? state : null;
      }, 'right-click, drag and scroll native event delivery');
    }
    const beforeHash = sha(await fs.readFile(before.image)), afterHash = sha(await fs.readFile(after.image));
    if (before.pid !== owner.pid || after.pid !== owner.pid || beforeHash === afterHash) throw new Error('Native probe target/frame assertions failed');
    return { ok: permissions.postEvents, code: permissions.postEvents ? null : 'INPUT_PERMISSION', axInputProved: true, keyboardInputProved: permissions.postEvents, input: permissions.postEvents ? 'AXPress, keyboard and pointer' : 'AXPress only', pid: owner.pid, bridge, permissions, pointerReady: permissions.postEvents,
      beforeFrame: path.relative(ROOT, before.image), afterFrame: path.relative(ROOT, after.image), beforeHash, afterHash, actions: driver.actions,
      boundary: permissions.postEvents ? 'Native input capability available; mounted Herdr proof is still required.' : 'AX input proved. GPUI pointer tests require macOS input access for the compiled helper.' };
  } catch (error) {
    try { error.diagnostics = { ...error.diagnostics, state: JSON.parse(await fs.readFile(stateFile, 'utf8')), actions: driver.actions, probeExitCode: child.exitCode, probeStderr }; } catch {}
    throw error;
  } finally {
    if (child.exitCode === null) { verified(owner); child.kill('SIGTERM'); }
    OWNERS.delete(owner.nonce);
  }
}

async function main(args) {
  if (args[0] === 'probe') {
    await fs.mkdir(path.join(ROOT, '.browse/sessions'), { recursive: true });
    let receipt;
    try { receipt = await probe(); }
    catch (error) { receipt = { ok: false, code: error.code || 'NATIVE_DRIVER', message: error.message, diagnostics: error.diagnostics }; }
    receipt.driverSourceSha256 = sha(await fs.readFile(SOURCE));
    receipt.driverScriptSha256 = sha(await fs.readFile(fileURLToPath(import.meta.url)));
    await fs.mkdir(path.join(ROOT, 'evidence/native'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'evidence/native/input-probe.json'), JSON.stringify(receipt, null, 2) + '\n');
    if (!receipt.ok) process.exitCode = 1;
    return receipt;
  }
  if (args[0] === 'permissions') return JSON.parse(command(await ensureNativeDriver(), ['permissions', ...(args.includes('--request') ? ['--request'] : [])]));
  throw new Error('Usage: node scripts/native-driver.mjs probe | permissions [--request]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'NATIVE_DRIVER', message: error.message }));
    process.exitCode = 1;
  });
}
