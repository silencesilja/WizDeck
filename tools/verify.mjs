#!/usr/bin/env node
/**
 * Hardware verification: drives the real engine against a real WiZ bulb and
 * confirms every change by reading the bulb back over raw UDP (never through
 * the engine's own cache). Restores the bulb's original state at the end.
 *
 *   node tools/verify.mjs [ip]
 */
import { createRequire } from 'node:module';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createEngine } = require('../src/main/wiz/engine.js');

const target = process.argv[2] || null;
const dir = mkdtempSync(path.join(tmpdir(), 'wizdeck-'));
const storePath = path.join(dir, 'wiz.json');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS - ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Independent read path: raw UDP getPilot, no engine involvement. */
function getPilot(ip, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => {
      try { s.close(); } catch {}
      reject(new Error('timeout'));
    }, timeout);
    s.on('message', (m) => {
      clearTimeout(t);
      try { s.close(); } catch {}
      try { resolve(JSON.parse(m.toString()).result); } catch (e) { reject(e); }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
    s.send(Buffer.from(JSON.stringify({ method: 'getPilot', params: {} })), 38899, ip);
  });
}

const states = [];
const engine = createEngine({ storePath, onState: (s) => states.push(s), log: () => {} });

console.log('== discovery ==');
const t0 = Date.now();
if (target) await engine.connect(target);
else await engine.start();
const found = engine.getState();
ok('discovery finished under 10s', Date.now() - t0 < 10000, `${Date.now() - t0}ms`);
ok('at least one WiZ bulb found', found.lights.length > 0, `${found.lights.length} bulb(s)`);
if (!found.lights.length) {
  console.log('\n== FAIL == no bulb on the network; nothing to verify');
  engine.dispose();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const light = found.lights[0];
const ip = found.candidates[0].address;
console.log(`bulb: ${light.name} ${ip} mac=${light.id} module=${light.archetype}`);
ok('status connected', found.status === 'connected', found.message);
ok('caps.color', light.caps.color === true);
ok('caps.ct', light.caps.ct === true);
ok('mirek range from cctRange', light.mirekMin === 154 && light.mirekMax === 455, `${light.mirekMin}..${light.mirekMax}`);
ok('effects list populated', light.effects.length > 30, `${light.effects.length} scenes`);
ok('room group built', found.groups.length >= 1 && found.groups[0].lightIds.includes(light.id));
ok('scene chips built', found.scenes.length >= 5, `${found.scenes.length}`);
ok('hex swatch derived', typeof light.hex === 'string' && /^#[0-9a-f]{6}$/.test(light.hex), light.hex);

const original = await getPilot(ip);
console.log('original pilot:', JSON.stringify(original));

console.log('\n== control ==');
let r = await engine.setLight(light.id, { on: true });
await sleep(600);
let p = await getPilot(ip);
ok('setLight {on:true}', r.ok && p.state === true);

r = await engine.setLight(light.id, { bri: 42 });
await sleep(700);
p = await getPilot(ip);
ok('setLight {bri:42} -> dimming 42', r.ok && p.dimming === 42, `dimming=${p.dimming}`);

r = await engine.setLight(light.id, { bri: 5 });
await sleep(700);
p = await getPilot(ip);
ok('brightness clamped to minDimLevel', r.ok && p.dimming === 10, `dimming=${p.dimming}`);

r = await engine.setLight(light.id, { hex: '#00ff88' });
await sleep(800);
p = await getPilot(ip);
ok('setLight {hex:#00ff88} -> rgb', r.ok && p.g > 200 && p.b > 80 && p.r < 40, `r=${p.r} g=${p.g} b=${p.b}`);
ok('colour clears scene', (p.sceneId || 0) === 0, `sceneId=${p.sceneId}`);

r = await engine.setLight(light.id, { hex: '#ff0000' });
await sleep(800);
p = await getPilot(ip);
ok('setLight {hex:#ff0000} -> red', r.ok && p.r > 220 && p.g < 40 && p.b < 40, `r=${p.r} g=${p.g} b=${p.b}`);

r = await engine.setLight(light.id, { kelvin: 2700 });
await sleep(800);
p = await getPilot(ip);
ok('setLight {kelvin:2700} -> temp', r.ok && p.temp === 2700, `temp=${p.temp}`);

r = await engine.setLight(light.id, { mirek: 154 });
await sleep(800);
p = await getPilot(ip);
ok('setLight {mirek:154} -> ~6500K', r.ok && p.temp >= 6400, `temp=${p.temp}`);

r = await engine.setLight(light.id, { kelvin: 9000 });
await sleep(800);
p = await getPilot(ip);
ok('kelvin clamped to bulb range', r.ok && p.temp === 6500, `temp=${p.temp}`);

r = await engine.setLight(light.id, { effect: 'Ocean' });
await sleep(900);
p = await getPilot(ip);
ok('setLight {effect:Ocean} -> sceneId 1', r.ok && p.sceneId === 1, `sceneId=${p.sceneId}`);
ok('dynamic scene carries speed', Number.isFinite(p.speed), `speed=${p.speed}`);

r = await engine.setLight(light.id, { effect: 'Cozy', dynamicsSpeed: 0.9 });
await sleep(900);
p = await getPilot(ip);
ok('setLight {effect:Cozy} -> sceneId 6', r.ok && p.sceneId === 6, `sceneId=${p.sceneId}`);

r = await engine.setLight(light.id, { effect: 'no_effect', hex: '#3355ff' });
await sleep(900);
p = await getPilot(ip);
ok('no_effect + colour returns to RGB', r.ok && (p.sceneId || 0) === 0 && p.b > 200, `sceneId=${p.sceneId} b=${p.b}`);

console.log('\n== groups, scenes, identify ==');
const group = engine.getState().groups[0];
r = await engine.setGroup(group.id, { bri: 70 });
await sleep(800);
p = await getPilot(ip);
ok('setGroup {bri:70}', r.ok && p.dimming === 70, `dimming=${p.dimming}`);

const scene = engine.getState().scenes.find((s) => s.name === 'Warm white');
r = await engine.activateScene(scene.id, {});
await sleep(900);
p = await getPilot(ip);
ok('activateScene Warm white -> sceneId 11', r.ok && p.sceneId === 11, `sceneId=${p.sceneId}`);

r = await engine.identify(light.id);
ok('identify (pulse) accepted', r.ok);

console.log('\n== state propagation ==');
const before = states.length;
// Change the bulb behind the engine's back; polling/syncPilot must notice.
await new Promise((res) => {
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from(JSON.stringify({ method: 'setPilot', params: { state: true, dimming: 88 } })), 38899, ip, () => {
    setTimeout(() => { try { s.close(); } catch {} ; res(); }, 200);
  });
});
let seen = false;
for (let i = 0; i < 20 && !seen; i += 1) {
  await sleep(500);
  const cur = engine.getState().lights.find((l) => l.id === light.id);
  if (cur && cur.bri === 88) seen = true;
}
ok('external change reflected in AppState within 10s', seen, `pushes=${states.length - before}`);

console.log('\n== reachability / offline handling ==');
r = await engine.setLight('deadbeefdead', { on: true });
ok('unknown bulb returns {ok:false} instead of throwing', r.ok === false, r.error);
r = await engine.connect('192.168.1.253');
ok('bad address returns {ok:false}', r.ok === false, r.error);
ok('engine still connected after a bad address', engine.getState().status === 'connected');

console.log('\n== rediscovery (survives a DHCP move) ==');
const rescan = await engine.discover({});
ok('rescan finds the bulb by MAC', rescan.ok && rescan.candidates.some((c) => c.id === light.id), `${rescan.candidates.length} candidate(s)`);
ok('address persisted for next launch', JSON.parse(require('node:fs').readFileSync(storePath, 'utf8')).bulbs[light.id].address === ip);

console.log('\n== rename (WizDeck-side name, stored by MAC) ==');
const defaultName = engine.getState().lights.find((l) => l.id === light.id).name;
r = await engine.renameLight(light.id, '  Verify  Lamp  ');
let renamed = engine.getState();
ok('renameLight collapses whitespace', r.ok && r.name === 'Verify Lamp', r.error || r.name);
ok('name shows on the light', renamed.lights.find((l) => l.id === light.id).name === 'Verify Lamp');
ok('name shows on the candidate', renamed.candidates.find((c) => c.id === light.id).name === 'Verify Lamp');
ok('name persisted by MAC', JSON.parse(require('node:fs').readFileSync(storePath, 'utf8')).bulbs[light.id].name === 'Verify Lamp');
const reloaded = createEngine({ storePath, log: () => {} });
await reloaded.start();
ok('name survives a restart', (reloaded.getState().lights.find((l) => l.id === light.id) || {}).name === 'Verify Lamp');
reloaded.dispose();
r = await engine.renameLight(light.id, '   ');
ok('empty name falls back to the default', r.ok && engine.getState().lights.find((l) => l.id === light.id).name === defaultName, defaultName);
r = await engine.renameLight('deadbeefdead', 'Nope');
ok('renaming an unknown bulb returns {ok:false}', r.ok === false, r.error);

console.log('\n== restore original state ==');
const restore = { state: original.state };
if (Number.isFinite(original.dimming)) restore.dimming = original.dimming;
if (Number.isFinite(original.sceneId) && original.sceneId > 0) restore.sceneId = original.sceneId;
else if (Number.isFinite(original.temp)) restore.temp = original.temp;
else if (Number.isFinite(original.r)) Object.assign(restore, { r: original.r, g: original.g, b: original.b });
await new Promise((res) => {
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from(JSON.stringify({ method: 'setPilot', params: restore })), 38899, ip, () => {
    setTimeout(() => { try { s.close(); } catch {} ; res(); }, 300);
  });
});
p = await getPilot(ip);
ok('bulb restored', p.state === original.state && (p.sceneId || 0) === (original.sceneId || 0), JSON.stringify(p));

engine.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(`\n================ ${fail ? 'FAIL' : 'PASS'} ================`);
console.log(`checks passed: ${pass}, failed: ${fail}`);
process.exit(fail ? 1 : 0);
