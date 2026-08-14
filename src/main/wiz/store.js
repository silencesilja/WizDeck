'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Tiny atomic JSON store: remembers bulbs by MAC so a DHCP move is invisible. */
function createStore(storePath) {
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      cache = {};
    }
    if (!cache.bulbs || typeof cache.bulbs !== 'object') cache.bulbs = {};
    return cache;
  }

  function write(next) {
    cache = next;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, storePath);
    } catch (_) { /* a read-only home must not break the app */ }
  }

  return {
    read,
    rememberBulb(mac, info) {
      const data = read();
      data.bulbs[mac] = { ...(data.bulbs[mac] || {}), ...info };
      write(data);
    },
    forget() {
      write({ bulbs: {} });
    },
  };
}

module.exports = { createStore };
