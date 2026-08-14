'use strict';

/**
 * WiZ engine. Owns the whole app state and speaks the same contract the
 * renderer already consumes: AppState in, normalized patches out.
 *
 * Bulbs are keyed by MAC, never by IP, so DHCP handing out a new address is a
 * non-event: the next broadcast scan finds the same MAC and the new address is
 * persisted underneath the UI.
 */

const os = require('node:os');
const proto = require('./protocol.js');
const color = require('./color.js');
const { createStore } = require('./store.js');

const PUSH_DEBOUNCE_MS = 40;
const POLL_ACTIVE_MS = 3000;
const POLL_IDLE_MS = 8000;
const RESCAN_MS = 20000;
const OFFLINE_AFTER_MS = 12000;
const ACTIVITY_WINDOW_MS = 30000;

function createEngine({ storePath, onState, log } = {}) {
  const store = createStore(storePath || './wiz-store.json');
  const trace = typeof log === 'function' ? log : () => {};

  /** @type {Map<string, any>} mac -> bulb record */
  const bulbs = new Map();
  /** mac -> user-chosen name. WiZ never reports one, so the store is the source. */
  const names = new Map(
    Object.entries(store.read().bulbs || {})
      .filter(([, info]) => info && typeof info.name === 'string' && info.name.trim())
      .map(([mac, info]) => [mac, info.name.trim()])
  );
  let state = {
    status: 'idle',
    message: '',
    scanning: false,
    bridge: null,
    candidates: [],
    lights: [],
    groups: [],
    scenes: [],
    lastUpdate: Date.now(),
  };

  let started = false;
  let disposed = false;
  let scanning = null;
  let sync = null;
  let pollTimer = null;
  let rescanTimer = null;
  let pushTimer = null;
  let lastActivity = 0;

  const clearTimer = (t) => {
    clearTimeout(t);
    return null;
  };

  function push() {
    if (disposed || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (typeof onState === 'function') {
        try {
          onState(state);
        } catch (err) {
          trace('state listener threw', err && err.message);
        }
      }
    }, PUSH_DEBOUNCE_MS);
    if (pushTimer.unref) pushTimer.unref();
  }

  function setState(patch) {
    state = { ...state, ...patch, lastUpdate: Date.now() };
    push();
  }

  const markActivity = () => {
    lastActivity = Date.now();
  };

  function lastOctet(address) {
    const m = /(\d+)\s*$/.exec(String(address || '').split(':')[0]);
    return m ? m[1] : '?';
  }

  /** The local protocol has no name field, so ours wins over the ".146" fallback. */
  function displayName(bulb) {
    return names.get(bulb.mac) || `WiZ Bulb .${lastOctet(bulb.address)}`;
  }

  const cleanName = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

  /* ---------------------------------------------------------- bulb records */

  function upsert(mac, patch) {
    const prev = bulbs.get(mac) || {
      mac,
      address: null,
      pilot: {},
      system: null,
      model: null,
      lastSeen: 0,
      pendingUntil: 0,
    };
    const next = { ...prev, ...patch };
    bulbs.set(mac, next);
    return next;
  }

  function caps(bulb) {
    const module = String((bulb.system && bulb.system.moduleName) || '');
    const rgb = /RGB/i.test(module);
    const cct = /RGB|TW|C\b|_C|CW/i.test(module) || Boolean(bulb.model && bulb.model.cctRange);
    return {
      dimming: true,
      color: rgb,
      ct: cct || rgb,
      effects: true,
      gradient: Boolean(bulb.model && bulb.model.hasGradient),
      identify: true,
    };
  }

  function kelvinRange(bulb) {
    const range = (bulb.model && bulb.model.cctRange) || [];
    const min = Number(range[0]) || 2200;
    const max = Number(range[2]) || 6500;
    return { min, max };
  }

  function minDim(bulb) {
    const v = bulb.model && Number(bulb.model.minDimLevel);
    return Number.isFinite(v) && v > 0 ? v : 10;
  }

  function roomKey(bulb) {
    const id = bulb.system && bulb.system.roomId;
    return id === undefined || id === null ? 'room:unknown' : `room:${id}`;
  }

  /** Stable, human room labels; a single room reads better as "All lights". */
  function roomLabels() {
    const ids = [...new Set([...bulbs.values()].map(roomKey))].sort();
    const labels = new Map();
    ids.forEach((id, idx) => {
      labels.set(id, ids.length === 1 ? 'All lights' : `Room ${idx + 1}`);
    });
    return labels;
  }

  function toLight(bulb, roomName) {
    const pilot = bulb.pilot || {};
    const c = caps(bulb);
    const { min, max } = kelvinRange(bulb);
    const hasRgb = Number.isFinite(pilot.r) || Number.isFinite(pilot.g) || Number.isFinite(pilot.b);
    const rgb = hasRgb ? { r: pilot.r || 0, g: pilot.g || 0, b: pilot.b || 0 } : null;
    const kelvin = Number.isFinite(pilot.temp) ? pilot.temp : null;
    const bri = Number.isFinite(pilot.dimming) ? pilot.dimming : null;
    const swatch = rgb ? color.rgbToHex(rgb) : kelvin ? color.rgbToHex(color.kelvinToRgb(kelvin)) : null;
    const reachable = Date.now() - bulb.lastSeen < OFFLINE_AFTER_MS;

    return {
      id: bulb.mac,
      name: displayName(bulb),
      room: roomName || null,
      on: Boolean(pilot.state),
      reachable,
      bri: c.dimming ? (bri === null ? null : Math.round(bri)) : null,
      mirek: kelvin ? color.kelvinToMirek(kelvin) : null,
      mirekMin: color.kelvinToMirek(max),
      mirekMax: color.kelvinToMirek(min),
      xy: rgb ? color.rgbToXy(rgb) : null,
      hex: swatch ? color.shade(swatch, bri === null ? 100 : bri) : null,
      gamut: null,
      effect: proto.sceneName(Number(pilot.sceneId) || 0),
      effects: c.effects ? proto.SCENES.slice() : [],
      archetype: (bulb.system && bulb.system.moduleName) || null,
      caps: c,
    };
  }

  /** Rebuild lights/groups/scenes from the bulb map. */
  function rebuild() {
    const labels = roomLabels();
    const lights = [...bulbs.values()]
      .sort((a, b) => String(a.address).localeCompare(String(b.address)))
      .map((bulb) => toLight(bulb, labels.get(roomKey(bulb))));

    const groups = [];
    const scenes = [];
    for (const [key, name] of labels) {
      const members = [...bulbs.values()].filter((b) => roomKey(b) === key);
      const memberLights = members.map((b) => lights.find((l) => l.id === b.mac)).filter(Boolean);
      if (!memberLights.length) continue;
      const on = memberLights.some((l) => l.on);
      const dimmable = memberLights.filter((l) => l.bri !== null);
      groups.push({
        id: key,
        name,
        kind: 'room',
        on,
        bri: dimmable.length ? Math.round(dimmable.reduce((sum, l) => sum + l.bri, 0) / dimmable.length) : null,
        lightIds: memberLights.map((l) => l.id),
        archetype: null,
      });
      for (const id of proto.FEATURED_SCENES) {
        scenes.push({ id: `scene:${key}:${id}`, name: proto.sceneName(id), groupId: key, groupName: name });
      }
    }

    const online = lights.filter((l) => l.reachable).length;
    const bridge = lights.length
      ? {
          address: [...bulbs.values()].map((b) => b.address).filter(Boolean).join(', '),
          id: String((([...bulbs.values()][0] || {}).system || {}).homeId || 'wiz'),
          name: lights.length === 1 ? lights[0].name : `WiZ · ${lights.length} bulbs`,
          modelid: (([...bulbs.values()][0] || {}).system || {}).moduleName || 'WiZ',
          swversion: (([...bulbs.values()][0] || {}).system || {}).fwVersion || '',
          apiVersion: 2,
          paired: true,
        }
      : null;

    setState({
      lights,
      groups,
      scenes,
      bridge,
      candidates: [...bulbs.values()].map((b) => ({
        address: b.address,
        id: b.mac,
        name: displayName(b),
        source: b.source || 'sweep',
        reachable: Date.now() - b.lastSeen < OFFLINE_AFTER_MS,
      })),
      status: !lights.length ? (state.scanning ? 'searching' : 'not_found') : online ? 'connected' : 'offline',
      message: !lights.length
        ? state.scanning
          ? 'Looking for WiZ bulbs on your network…'
          : 'No WiZ bulbs answered on UDP 38899. Check they are powered and on this Wi-Fi.'
        : online
          ? `${online} of ${lights.length} bulb${lights.length > 1 ? 's' : ''} online`
          : 'Bulb stopped answering. Retrying…',
    });
  }

  /* --------------------------------------------------------------- refresh */

  async function refreshBulb(mac, { deep = false } = {}) {
    const bulb = bulbs.get(mac);
    if (!bulb || !bulb.address) return false;
    try {
      const pilot = await proto.send(bulb.address, 'getPilot', {}, { timeout: 1200, retries: 1 });
      const patch = { lastSeen: Date.now() };
      // Do not clobber an optimistic write the bulb has not echoed yet.
      if (Date.now() >= (bulb.pendingUntil || 0)) patch.pilot = pilot;
      if (deep || !bulb.system) {
        try {
          patch.system = await proto.send(bulb.address, 'getSystemConfig', {}, { timeout: 1200, retries: 1 });
        } catch (_) { /* optional */ }
      }
      if (deep || !bulb.model) {
        try {
          patch.model = await proto.send(bulb.address, 'getModelConfig', {}, { timeout: 1200, retries: 1 });
        } catch (_) { /* older firmware lacks it */ }
      }
      const next = upsert(mac, patch);
      store.rememberBulb(mac, {
        address: next.address,
        moduleName: next.system && next.system.moduleName,
        roomId: next.system && next.system.roomId,
        homeId: next.system && next.system.homeId,
      });
      return true;
    } catch (err) {
      trace('bulb unreachable', mac, err && err.message);
      return false;
    }
  }

  async function refreshAll(options) {
    await Promise.all([...bulbs.keys()].map((mac) => refreshBulb(mac, options)));
    rebuild();
  }

  function schedulePoll() {
    pollTimer = clearTimer(pollTimer);
    if (disposed || !started) return;
    const idle = Date.now() - lastActivity > ACTIVITY_WINDOW_MS;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      refreshAll().catch(() => {}).then(schedulePoll);
    }, idle ? POLL_IDLE_MS : POLL_ACTIVE_MS);
    if (pollTimer.unref) pollTimer.unref();
  }

  function scheduleRescan() {
    rescanTimer = clearTimer(rescanTimer);
    if (disposed || !started) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      const stale = !bulbs.size || [...bulbs.values()].some((b) => Date.now() - b.lastSeen > OFFLINE_AFTER_MS);
      // Only burn a broadcast when something is actually missing.
      (stale ? runScan({ force: true }) : Promise.resolve()).catch(() => {}).then(scheduleRescan);
    }, RESCAN_MS);
    if (rescanTimer.unref) rescanTimer.unref();
  }

  /* ------------------------------------------------------------- discovery */

  function runScan(options) {
    const force = Boolean(options && options.force);
    if (scanning && !force) return scanning;
    const known = store.read().bulbs || {};
    const hosts = [...new Set([...Object.values(known).map((b) => b.address), ...[...bulbs.values()].map((b) => b.address)])].filter(Boolean);

    setState({ scanning: true, status: state.lights.length ? state.status : 'searching', message: state.lights.length ? state.message : 'Looking for WiZ bulbs on your network…' });

    const promise = (async () => {
      let found = [];
      try {
        found = await proto.scan({
          timeout: (options && options.timeout) || 2500,
          hosts,
          onFound: (hit) => {
            upsert(hit.mac, { address: hit.address, lastSeen: Date.now(), source: 'sweep', pilot: hit.result.state !== undefined ? hit.result : (bulbs.get(hit.mac) || {}).pilot || {} });
          },
        });
      } catch (err) {
        trace('scan failed', err && err.message);
      }
      setState({ scanning: false });
      // Fill in capabilities/config for anything new, then publish.
      await Promise.all(found.map((hit) => refreshBulb(hit.mac, { deep: !((bulbs.get(hit.mac) || {}).system) })));
      for (const hit of found) {
        proto.registerForPushes(hit.address).catch(() => {});
      }
      rebuild();
      return state.candidates;
    })();

    scanning = promise;
    return promise.finally(() => {
      if (scanning === promise) scanning = null;
    });
  }

  /* --------------------------------------------------------------- writing */

  /** Normalized patch -> WiZ setPilot params. */
  function buildPilot(bulb, patch) {
    const params = {};
    const c = caps(bulb);
    const floor = minDim(bulb);
    let touchesLight = false;

    if (patch.on !== undefined) params.state = Boolean(patch.on);

    if (patch.bri !== undefined && patch.bri !== null) {
      params.dimming = Math.round(color.clamp(patch.bri, floor, 100));
      touchesLight = true;
    }
    if (patch.briDelta !== undefined && patch.briDelta !== null) {
      const current = Number.isFinite(bulb.pilot && bulb.pilot.dimming) ? bulb.pilot.dimming : 50;
      params.dimming = Math.round(color.clamp(current + patch.briDelta, floor, 100));
      touchesLight = true;
    }

    const hex = patch.hex || null;
    const xy = patch.xy || null;
    if ((hex || xy) && c.color) {
      let rgb = hex ? color.hexToRgb(hex) : null;
      if (!rgb && xy) {
        // xy -> rgb via the same primaries the UI used to build it.
        const Y = 1;
        const X = (Y / xy.y) * xy.x;
        const Z = (Y / xy.y) * (1 - xy.x - xy.y);
        const lin = [
          X * 1.656492 + Y * -0.354851 + Z * -0.255038,
          X * -0.707196 + Y * 1.655397 + Z * 0.036152,
          X * 0.051713 + Y * -0.121364 + Z * 1.011530,
        ].map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055));
        const peak = Math.max(...lin, 1);
        rgb = { r: (lin[0] / peak) * 255, g: (lin[1] / peak) * 255, b: (lin[2] / peak) * 255 };
      }
      if (rgb) {
        params.r = Math.round(color.clamp(rgb.r, 0, 255));
        params.g = Math.round(color.clamp(rgb.g, 0, 255));
        params.b = Math.round(color.clamp(rgb.b, 0, 255));
        // Firmware rejects `sceneId`/`c`/`w` sent alongside r/g/b
        // ("Invalid params", code -32602); RGB alone clears the scene anyway.
        touchesLight = true;
      }
    }

    const kelvin = patch.kelvin !== undefined && patch.kelvin !== null
      ? patch.kelvin
      : patch.mirek !== undefined && patch.mirek !== null
        ? color.mirekToKelvin(patch.mirek)
        : null;
    if (kelvin !== null && c.ct && params.r === undefined) {
      const { min, max } = kelvinRange(bulb);
      params.temp = Math.round(color.clamp(kelvin, min, max));
      touchesLight = true;
    }

    if (patch.effect !== undefined && patch.effect !== null) {
      const id = proto.sceneId(patch.effect);
      if (id !== null) {
        if (id > 0) {
          // A scene is exclusive with colour/CT on the wire.
          params.sceneId = id;
          delete params.r;
          delete params.g;
          delete params.b;
          delete params.temp;
          if (proto.DYNAMIC_SCENES.has(id)) {
            const speed = patch.dynamicsSpeed === undefined || patch.dynamicsSpeed === null ? 0.5 : patch.dynamicsSpeed;
            params.speed = Math.round(color.clamp(10 + speed * 190, 10, 200));
          }
        } else if (params.r === undefined && params.temp === undefined) {
          // "No effect" has no wire representation: leaving a scene means
          // committing to a plain white, so re-assert the current CCT.
          const { min, max } = kelvinRange(bulb);
          const current = Number.isFinite(bulb.pilot && bulb.pilot.temp) ? bulb.pilot.temp : 2700;
          params.temp = Math.round(color.clamp(current, min, max));
        }
        touchesLight = true;
      }
    }

    // Hue semantics the UI is written against: changing light output implies on.
    if (touchesLight && params.state === undefined && patch.on !== false) params.state = true;
    return params;
  }

  /** Apply locally first so the UI never waits on a datagram round trip. */
  function applyOptimistic(mac, params) {
    const bulb = bulbs.get(mac);
    if (!bulb) return;
    const pilot = { ...bulb.pilot };
    if (params.state !== undefined) pilot.state = params.state;
    if (params.dimming !== undefined) pilot.dimming = params.dimming;
    if (params.temp !== undefined) {
      pilot.temp = params.temp;
      delete pilot.r;
      delete pilot.g;
      delete pilot.b;
      pilot.sceneId = 0; // the bulb drops out of its scene on any CT write
    }
    if (params.r !== undefined) {
      pilot.r = params.r;
      pilot.g = params.g;
      pilot.b = params.b;
      delete pilot.temp;
      pilot.sceneId = 0;
    }
    if (params.sceneId !== undefined) pilot.sceneId = params.sceneId;
    if (params.speed !== undefined) pilot.speed = params.speed;
    upsert(mac, { pilot, pendingUntil: Date.now() + 1500 });
  }

  async function writeBulb(mac, patch) {
    const bulb = bulbs.get(mac);
    if (!bulb) return { ok: false, error: `unknown bulb ${mac}` };
    if (!bulb.address) return { ok: false, error: `no address for ${mac}` };
    const params = buildPilot(bulb, patch || {});
    if (!Object.keys(params).length) return { ok: true };
    markActivity();
    applyOptimistic(mac, params);
    rebuild();
    try {
      await proto.send(bulb.address, 'setPilot', params, { timeout: 1200, retries: 2 });
      upsert(mac, { lastSeen: Date.now() });
      setTimeout(() => refreshBulb(mac).then(rebuild).catch(() => {}), 700);
      return { ok: true };
    } catch (err) {
      trace('write failed', mac, err && err.message);
      upsert(mac, { pendingUntil: 0 });
      await refreshBulb(mac);
      rebuild();
      return { ok: false, error: err && err.message ? err.message : 'bulb did not answer' };
    }
  }

  /* ------------------------------------------------------------------- api */

  const engine = {
    getState() {
      return state;
    },

    async start() {
      if (started || disposed) return { ok: true };
      started = true;
      sync = proto.openSyncListener(({ mac, address, pilot }) => {
        const known = bulbs.get(mac);
        const patch = { address: address || (known && known.address), lastSeen: Date.now() };
        if (!known || Date.now() >= (known.pendingUntil || 0)) patch.pilot = { ...(known ? known.pilot : {}), ...pilot };
        upsert(mac, patch);
        if (!known || !known.system) refreshBulb(mac, { deep: true }).then(rebuild).catch(() => {});
        else rebuild();
      });
      await runScan({ force: true });
      schedulePoll();
      scheduleRescan();
      return { ok: true };
    },

    async discover(options) {
      try {
        markActivity();
        if (!started) await engine.start();
        const candidates = await runScan({ force: true, timeout: (options && options.timeout) || 3000 });
        return { ok: true, candidates };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'scan failed', candidates: state.candidates };
      }
    },

    /** Adopt a bulb the user typed in by hand (or a cached address). */
    async connect(address) {
      try {
        markActivity();
        if (!started) {
          started = true;
          sync = sync || proto.openSyncListener(({ mac, address: from, pilot }) => {
            upsert(mac, { address: from, lastSeen: Date.now(), pilot });
            rebuild();
          });
          schedulePoll();
          scheduleRescan();
        }
        if (!address) return engine.discover({});
        const addr = String(address).trim();
        const system = await proto.send(addr, 'getSystemConfig', {}, { timeout: 1500, retries: 2 });
        if (!system || !system.mac) return { ok: false, error: `no WiZ bulb answered at ${addr}` };
        const mac = String(system.mac).toLowerCase();
        upsert(mac, { address: proto.parseAddress(addr).host, system, lastSeen: Date.now(), source: 'manual' });
        await refreshBulb(mac, { deep: true });
        proto.registerForPushes(addr).catch(() => {});
        rebuild();
        return { ok: true, address: addr, apiVersion: 2 };
      } catch (err) {
        const msg = err && err.message ? err.message : 'could not reach that address';
        setState({ status: state.lights.length ? state.status : 'not_found', message: msg });
        return { ok: false, error: msg };
      }
    },

    /** WiZ has no pairing; keep the method so the IPC surface stays stable. */
    async pair() {
      return { ok: true, message: 'WiZ bulbs need no pairing — they answer on the local network directly.' };
    },

    async forget() {
      bulbs.clear();
      names.clear();
      store.forget();
      rebuild();
      return { ok: true };
    },

    async setLight(id, patch) {
      return writeBulb(String(id), patch || {});
    },

    /** Names are ours alone: persist by MAC so DHCP and restarts keep them. */
    async renameLight(id, name) {
      const mac = String(id);
      if (!bulbs.has(mac)) return { ok: false, error: `unknown bulb ${mac}` };
      const clean = cleanName(name);
      if (clean) names.set(mac, clean);
      else names.delete(mac);
      store.rememberBulb(mac, { name: clean || null });
      rebuild();
      return { ok: true, name: displayName(bulbs.get(mac)) };
    },

    async setGroup(id, patch) {
      const group = state.groups.find((g) => g.id === String(id));
      if (!group) return { ok: false, error: `unknown group ${id}` };
      const results = await Promise.all(group.lightIds.map((mac) => writeBulb(mac, patch || {})));
      const failed = results.filter((r) => !r.ok);
      return failed.length ? { ok: false, error: failed[0].error } : { ok: true };
    },

    async activateScene(id, options) {
      const parts = String(id || '').split(':');
      const scene = Number(parts[parts.length - 1]);
      const groupId = parts.slice(1, -1).join(':');
      if (!Number.isFinite(scene)) return { ok: false, error: `unknown scene ${id}` };
      return engine.setGroup(groupId, {
        effect: proto.sceneName(scene),
        dynamicsSpeed: options && options.dynamicsSpeed,
      });
    },

    async identify(id) {
      const bulb = bulbs.get(String(id));
      if (!bulb || !bulb.address) return { ok: false, error: `unknown bulb ${id}` };
      markActivity();
      try {
        await proto.send(bulb.address, 'pulse', { delta: -60, duration: 900 }, { timeout: 1500, retries: 1 });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'bulb did not answer' };
      }
    },

    async refresh() {
      try {
        markActivity();
        await refreshAll({ deep: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'refresh failed' };
      }
    },

    dispose() {
      disposed = true;
      started = false;
      pollTimer = clearTimer(pollTimer);
      rescanTimer = clearTimer(rescanTimer);
      pushTimer = clearTimer(pushTimer);
      if (sync) sync.close();
      sync = null;
    },
  };

  return engine;
}

module.exports = { createEngine, hostname: os.hostname };
