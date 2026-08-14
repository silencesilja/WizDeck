'use strict';

/**
 * WiZ local protocol: line-free JSON datagrams on UDP 38899.
 * Bulbs push unsolicited `syncPilot` frames to UDP 38900 of whoever registered.
 * No pairing, no cloud, no TLS.
 */

const dgram = require('node:dgram');
const os = require('node:os');

const PORT = 38899;
const SYNC_PORT = 38900;

/** Built-in WiZ scenes. Index === sceneId; 0 means "no effect" (plain light). */
const SCENES = [
  'no_effect', 'Ocean', 'Romance', 'Sunset', 'Party', 'Fireplace', 'Cozy', 'Forest',
  'Pastel colors', 'Wake-up', 'Bedtime', 'Warm white', 'Daylight', 'Cool white',
  'Night light', 'Focus', 'Relax', 'True colors', 'TV time', 'Plant growth', 'Spring',
  'Summer', 'Fall', 'Deep dive', 'Jungle', 'Mojito', 'Club', 'Christmas', 'Halloween',
  'Candlelight', 'Golden white', 'Pulse', 'Steampunk', 'Diwali', 'White',
];

/** Scenes whose animation honours `speed`. */
const DYNAMIC_SCENES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33]);

/** Chips worth surfacing at room level, in this order. */
const FEATURED_SCENES = [6, 11, 12, 14, 16, 4, 1, 3, 7, 18];

function sceneName(id) {
  return SCENES[id] || `Scene ${id}`;
}

function sceneId(name) {
  if (name === null || name === undefined) return null;
  const needle = String(name).trim().toLowerCase();
  if (!needle || needle === 'no_effect' || needle === 'none') return 0;
  const idx = SCENES.findIndex((s) => s.toLowerCase() === needle);
  if (idx >= 0) return idx;
  const num = Number(needle);
  return Number.isInteger(num) && num >= 0 && num < SCENES.length ? num : null;
}

/* --------------------------------------------------------------- addressing */

function parseAddress(address) {
  const raw = String(address || '').trim();
  const [host, port] = raw.split(':');
  return { host, port: port ? Number(port) : PORT };
}

/** Broadcast addresses of every non-loopback IPv4 interface, plus the global one. */
function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address.split('.').map(Number);
      const mask = String(net.netmask || '255.255.255.0').split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

/**
 * Every unicast host on our own /24-ish subnets. macOS routinely drops the
 * replies to a 255.255.255.255 probe, so the fan-out is what actually finds
 * bulbs here; it is only ~254 tiny datagrams.
 */
function subnetHosts(limit = 1024) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address.split('.').map(Number);
      const mask = String(net.netmask || '255.255.255.0').split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      const base = ip.map((o, i) => o & mask[i]);
      const size = mask.reduce((acc, o) => acc * (256 - o), 1);
      if (size < 2 || size > limit) continue; // skip /16 and wider
      for (let host = 1; host < size - 1; host += 1) {
        const addr = [...base];
        let carry = host;
        for (let i = 3; i >= 0 && carry; i -= 1) {
          addr[i] |= carry & 255;
          carry >>= 8;
        }
        const text = addr.join('.');
        if (text !== net.address) out.push(text);
      }
    }
  }
  return out;
}

/** Local IPv4 that can reach `host`, for the syncPilot registration handshake. */
function localAddressFor(host) {
  const target = String(host || '').split('.').map(Number);
  let fallback = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      fallback = fallback || net.address;
      const ip = net.address.split('.').map(Number);
      const mask = String(net.netmask || '255.255.255.0').split('.').map(Number);
      if (target.length === 4 && ip.every((o, i) => (o & mask[i]) === (target[i] & mask[i]))) return net.address;
    }
  }
  return fallback;
}

function localMac() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        return net.mac.replace(/:/g, '');
      }
    }
  }
  return 'ffffffffffff';
}

/* ------------------------------------------------------------------ request */

class WizError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WizError';
    this.code = code || 'EWIZ';
    this.transport = code === 'ETIMEDOUT' || code === 'ENETWORK';
  }
}

function isTransportError(err) {
  return Boolean(err && err.transport);
}

/**
 * One request/response exchange. UDP is lossy, so retry a couple of times
 * before declaring the bulb gone.
 */
function send(address, method, params, options) {
  const { host, port } = parseAddress(address);
  const timeout = (options && options.timeout) || 1200;
  const retries = (options && options.retries) === undefined ? 2 : options.retries;
  const payload = Buffer.from(JSON.stringify({ method, params: params || {} }));

  const attempt = (left) =>
    new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch (_) { /* already closed */ }
        fn(arg);
      };
      const timer = setTimeout(() => {
        finish(reject, new WizError(`${method} timed out talking to ${host}`, 'ETIMEDOUT'));
      }, timeout);

      socket.on('message', (msg) => {
        let json;
        try {
          json = JSON.parse(msg.toString());
        } catch (err) {
          finish(reject, new WizError(`malformed reply from ${host}`, 'EPROTO'));
          return;
        }
        if (json && json.error) {
          finish(reject, new WizError(json.error.message || 'bulb rejected the command', 'EBULB'));
          return;
        }
        finish(resolve, (json && json.result) || {});
      });
      socket.on('error', (err) => finish(reject, new WizError(err.message, 'ENETWORK')));
      socket.send(payload, port, host, (err) => {
        if (err) finish(reject, new WizError(err.message, 'ENETWORK'));
      });
    }).catch((err) => {
      if (left > 0 && isTransportError(err)) return attempt(left - 1);
      throw err;
    });

  return attempt(retries);
}

/**
 * Broadcast a `registration` probe and collect every bulb that answers.
 * Works regardless of the address DHCP handed out, which is the whole point.
 */
function scan(options) {
  const window = (options && options.timeout) || 2500;
  const extraHosts = (options && options.hosts) || [];
  const onFound = (options && options.onFound) || (() => {});
  const phoneIp = localAddressFor((extraHosts[0] || '').split(':')[0] || '192.168.1.1') || '0.0.0.0';
  const probe = Buffer.from(
    JSON.stringify({
      method: 'registration',
      params: { phoneIp, register: false, phoneMac: localMac(), id: '1' },
    })
  );
  const pilot = Buffer.from(JSON.stringify({ method: 'getPilot', params: {} }));

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(repeat);
      try {
        socket.close();
      } catch (_) { /* already closed */ }
      resolve([...found.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      let json;
      try {
        json = JSON.parse(msg.toString());
      } catch (_) {
        return;
      }
      const result = json && json.result;
      if (!result || !result.mac) return;
      const hit = { mac: String(result.mac).toLowerCase(), address: rinfo.address, result };
      if (found.has(hit.mac)) return;
      found.set(hit.mac, hit);
      try {
        onFound(hit);
      } catch (_) { /* listener problem is not ours */ }
    });
    socket.on('error', () => finish());

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (_) { /* some interfaces refuse; unicast still works */ }
      blast(true);
    });

    const blast = (withFanout) => {
      for (const target of broadcastTargets()) {
        socket.send(probe, PORT, target, () => {});
        socket.send(pilot, PORT, target, () => {});
      }
      for (const host of extraHosts) {
        const { host: h, port } = parseAddress(host);
        if (h) socket.send(pilot, port, h, () => {});
      }
      if (!withFanout) return;
      // Spread the per-host probes over a few ticks so the socket buffer and
      // the Wi-Fi link do not drop the tail of the burst.
      const hosts = subnetHosts();
      const CHUNK = 48;
      for (let i = 0; i < hosts.length; i += CHUNK) {
        const slice = hosts.slice(i, i + CHUNK);
        const t = setTimeout(() => {
          if (done) return;
          for (const h of slice) socket.send(pilot, PORT, h, () => {});
        }, (i / CHUNK) * 25);
        if (t.unref) t.unref();
      }
    };

    const repeat = setInterval(() => blast(false), 700);
    if (repeat.unref) repeat.unref();
    const timer = setTimeout(finish, window);
    if (timer.unref) timer.unref();
  });
}

/**
 * Listen for `syncPilot` pushes so the UI reflects changes made from the WiZ
 * app, a wall switch or another client without polling.
 */
function openSyncListener(onPilot) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => {
    let json;
    try {
      json = JSON.parse(msg.toString());
    } catch (_) {
      return;
    }
    if (!json || (json.method !== 'syncPilot' && json.method !== 'getPilot')) return;
    const params = json.params || json.result;
    if (!params || !params.mac) return;
    onPilot({ mac: String(params.mac).toLowerCase(), address: rinfo.address, pilot: params });
    // Bulbs expect an ack; without it they keep retransmitting.
    if (json.method === 'syncPilot' && json.id !== undefined) {
      const ack = Buffer.from(JSON.stringify({ method: 'syncPilot', id: json.id, env: json.env || 'pro', result: { success: true } }));
      socket.send(ack, rinfo.port, rinfo.address, () => {});
    }
  });
  socket.on('error', () => {
    try {
      socket.close();
    } catch (_) { /* already closed */ }
  });
  try {
    socket.bind(SYNC_PORT);
  } catch (_) { /* port busy: polling still covers us */ }
  return {
    close() {
      try {
        socket.close();
      } catch (_) { /* already closed */ }
    },
  };
}

/** Ask a bulb to start pushing syncPilot frames to us. */
async function registerForPushes(address) {
  const { host } = parseAddress(address);
  const phoneIp = localAddressFor(host);
  if (!phoneIp) return false;
  try {
    await send(address, 'registration', { phoneIp, register: true, phoneMac: localMac(), id: '1' }, { retries: 1, timeout: 900 });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  PORT,
  SYNC_PORT,
  SCENES,
  DYNAMIC_SCENES,
  FEATURED_SCENES,
  WizError,
  isTransportError,
  sceneName,
  sceneId,
  parseAddress,
  broadcastTargets,
  subnetHosts,
  localAddressFor,
  localMac,
  send,
  scan,
  openSyncListener,
  registerForPushes,
};
