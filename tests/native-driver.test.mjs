import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { flattenTree, pointInWindow, selectInputWindow, validateTarget, registerOwnedProcess, registerOwnedSocketProcess, socketOwners, NativeDriver } from '../scripts/native-driver.mjs';

test('ownership lookup finds the real Unix socket holder and rejects regular or closed files', async t => {
  const root=await fs.mkdtemp('/private/tmp/mc-native-socket-'),endpoint=path.join(root,'owned.sock'),regular=path.join(root,'regular');
  const server=net.createServer(),file=await fs.open(regular,'w');
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await file.close();await fs.rm(root,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
  assert.deepEqual(socketOwners(endpoint),[process.pid]);
  assert.throws(()=>socketOwners(regular));
  await new Promise(resolve=>server.close(resolve));
  assert.throws(()=>socketOwners(endpoint));
  assert.throws(()=>socketOwners('relative.sock'),/absolute Unix socket/);
});

test('native input requires an owned unchanged process identity', async () => {
  const owner = { pid: 123, nonce: 'owned', fingerprint: 'known start time and binary' };
  assert.equal(validateTarget(owner, { ...owner, exited: false }), owner);
  assert.throws(() => validateTarget(owner, { ...owner, pid: 124 }), /mismatched/);
  assert.throws(() => validateTarget(owner, { ...owner, fingerprint: 'reused pid' }), /mismatched/);
  assert.throws(() => validateTarget(owner, { ...owner, exited: true }), /Stale/);
  await assert.rejects(new NativeDriver(owner).tree(), /Unowned/);
  await assert.rejects(new NativeDriver(owner).bindWindow(undefined),/Invalid owned window identity/);
  assert.throws(() => registerOwnedProcess({ pid: process.pid, exitCode: null }, 'herdr'), /task-owned child/);
  await assert.rejects(registerOwnedSocketProcess({ directory: '/Users/ciprian/.config/herdr-app', socket: '/Users/ciprian/.config/herdr-app/herdr-app.sock' }), /scratch directory/);
});

test('pointer geometry rejects stale sizes, invalid coordinates and controls outside the owned window', () => {
  const frame = { x: 120, y: 80, width: 420, height: 200 };
  assert.deepEqual(pointInWindow(frame, { x: 10, y: 20, width: 40, height: 30 }, { width: 420, height: 200 }), { x: 150, y: 115 });
  assert.throws(() => pointInWindow(frame, { x: -1, y: 0, width: 10, height: 10 }), /outside/);
  assert.throws(() => pointInWindow(frame, { x: 419, y: 0, width: 10, height: 10 }), /outside/);
  assert.throws(() => pointInWindow(frame, { x: 0, y: 0, width: NaN, height: 10 }), /Invalid/);
  assert.throws(() => pointInWindow(frame, { x: 0, y: 0, width: 10, height: 10 }, { width: 800, height: 600 }), /Stale/);
});

test('an explicit verified window stays selected when its process exposes utility windows',()=>{
  const main={pid:123,id:10,width:1280,height:760},utility={pid:123,id:11,width:500,height:500};
  assert.equal(selectInputWindow([main],123),main);assert.equal(selectInputWindow([utility,main],123,10),main);
  assert.throws(()=>selectInputWindow([main,utility],123),/unique/);assert.throws(()=>selectInputWindow([utility],123,10),/unique/);
  assert.throws(()=>selectInputWindow([main,{...utility,pid:124}],123,10),/verified process/);assert.throws(()=>selectInputWindow([main],123,-1),/Invalid/);
});

test('AX inspection keeps native node identity for actual handler selection', () => {
  const tree = { role: 'AXApplication', children: [{ role: 'AXWindow', path: [0], children: [{ role: 'AXButton', path: [0, 0], label: 'Count 0', actions: ['AXPress'], enabled: true }] }] };
  const nodes = flattenTree(tree);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.find(n => n.label === 'Count 0').path, [0, 0]);
});

test('arbitrary or stale AX paths are rejected before they can become input evidence', async () => {
  const driver = new NativeDriver({});
  await assert.rejects(driver.action({ path: [-1], role: 'AXButton' }), /inspected/);
  driver.tree = async () => ({ role: 'AXButton', path: [0], label: 'changed', enabled: true, actions: ['AXPress'] });
  await assert.rejects(driver.action({ path: [0], role: 'AXButton', label: 'old' }), /Stale/);
  assert.deepEqual(driver.actions, []);
  await assert.rejects(driver.click({}, { button: 'middle' }), /Unsupported/);
  await assert.rejects(driver.scroll({}, 3000), /Invalid native scroll/);
});
