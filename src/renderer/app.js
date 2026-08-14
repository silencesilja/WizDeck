/* WizDeck renderer. Talks to the main process exclusively through window.hue.
   No Node, no network, no framework: AppState in, DOM diffs out. */

import {
  createWheel, kelvinGradient, kelvinToHex, mirekToKelvin, normalizeHex, clamp,
} from './wheel.js';

const api = typeof window !== 'undefined' && window.hue ? window.hue : null;

const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
const titleize = (s) => String(s).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ state */

function emptyState() {
  return {
    status: 'idle',
    message: '',
    scanning: false,
    bridge: null,
    candidates: [],
    lights: [],
    groups: [],
    scenes: [],
    lastUpdate: 0,
  };
}

/** Never trust a push to be complete; missing fields must not break a render. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    status: typeof s.status === 'string' ? s.status : 'idle',
    message: typeof s.message === 'string' ? s.message : '',
    scanning: Boolean(s.scanning),
    bridge: s.bridge && typeof s.bridge === 'object' ? s.bridge : null,
    candidates: arr(s.candidates),
    lights: arr(s.lights),
    groups: arr(s.groups),
    scenes: arr(s.scenes),
    lastUpdate: Number(s.lastUpdate) || 0,
  };
}

let state = emptyState();
let transitionMs = 400;

/* ------------------------------------------------------------------ toasts */

const toastHost = $('toasts');
const recentToasts = new Map();

function toast(message, kind = 'err', ttl = 6000) {
  const text = String(message || 'Something went wrong');
  const now = Date.now();
  const seen = recentToasts.get(text);
  if (seen && now - seen < 2500) return;
  recentToasts.set(text, now);

  const close = h('button', { class: 'toast__x', type: 'button', title: 'Dismiss', textContent: '\u00d7' });
  const node = h('div', { class: 'toast', dataset: { kind } },
    h('span', { class: 'toast__text', textContent: text }), close);
  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };
  close.addEventListener('click', dismiss);
  toastHost.append(node);
  setTimeout(dismiss, ttl);
}

/* --------------------------------------------------------------- api calls */

const MISSING_API = 'No bulb API in this window — open WizDeck through its main process.';

async function call(method, args = [], { silent = false } = {}) {
  if (!api || typeof api[method] !== 'function') {
    toast(MISSING_API);
    return { ok: false, error: MISSING_API };
  }
  try {
    const res = await api[method](...args);
    const out = res && typeof res === 'object' ? res : { ok: true };
    if (out.ok === false && !silent) toast(out.error || `${method} failed`);
    return out;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (!silent) toast(msg);
    return { ok: false, error: msg };
  }
}

/** Attach the chosen transition and drop unset keys — the engine reads `in patch`. */
function withDuration(patch) {
  const out = { duration: transitionMs };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = value;
  return out;
}

const setLight = (id, patch) => call('setLight', [id, patch]);
const setGroup = (id, patch) => call('setGroup', [id, patch]);

/* ------------------------------------------------- drag / edit protection */

const edits = new Map();

function editStart(key) { edits.set(key, { active: true, until: 0 }); }
function editEnd(key) {
  edits.set(key, { active: false, until: performance.now() + 450 });
  scheduleReconcile();
}
function editTouch(key) {
  const e = edits.get(key);
  if (e && e.active) return;
  edits.set(key, { active: false, until: performance.now() + 800 });
  scheduleReconcile();
}
function editing(key) {
  const e = edits.get(key);
  return Boolean(e) && (e.active || performance.now() < e.until);
}

let reconcileTimer = null;

/** Once the user lets go, re-apply the authoritative state that the guard skipped. */
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => render(state), 900);
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  let has = false;
  const run = () => {
    last = performance.now();
    has = false;
    const arg = pending;
    pending = null;
    fn(arg);
  };
  const call2 = (arg) => {
    pending = arg;
    has = true;
    const wait = ms - (performance.now() - last);
    if (wait <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      run();
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; if (has) run(); }, wait);
    }
  };
  call2.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    has = false;
    pending = null;
  };
  return call2;
}

function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--pct', `${clamp(pct, 0, 100)}%`);
}

/**
 * Range wiring: throttled trailing sends while moving, a hard commit on release,
 * and an edit guard so state pushes never yank the handle out of the user's hand.
 */
function bindRange(input, key, send) {
  let sent = null;
  const push = throttle((value) => { sent = value; send(value); }, 120);
  const commit = () => {
    push.cancel();
    const value = Number(input.value);
    if (value === sent) return; /* the throttle already delivered this exact value */
    sent = value;
    send(value);
  };
  input.addEventListener('pointerdown', () => {
    editStart(key);
    const release = () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      editEnd(key);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  });
  input.addEventListener('input', () => {
    editTouch(key);
    paintRange(input);
    push(Number(input.value));
  });
  input.addEventListener('change', commit);
  input.addEventListener('blur', () => editEnd(key));
}

/** Only adopt a remote value when the user is not working the control. */
function syncRange(input, key, value) {
  if (editing(key)) return;
  if (Number(input.value) !== value) input.value = String(value);
  paintRange(input);
}

/* ------------------------------------------------------- shared list diff */

function syncList(container, items, keyOf, factory, registry) {
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let node = registry.get(key);
    if (!node) {
      node = factory(item, key);
      registry.set(key, node);
    }
    const ref = prev ? prev.el.nextSibling : container.firstChild;
    if (ref !== node.el) container.insertBefore(node.el, ref);
    node.update(item);
    prev = node;
  }
  for (const [key, node] of [...registry]) {
    if (seen.has(key)) continue;
    node.el.remove();
    if (node.destroy) node.destroy();
    registry.delete(key);
  }
}

/* ----------------------------------------------------------- shared parts */

function makeSwitch(label) {
  const btn = h('button', {
    class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label,
  }, h('span', { class: 'switch__knob' }));
  return btn;
}

function setSwitch(btn, on) {
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
}

let fieldSeq = 0;

function makeField(labelText, input, { className = 'field' } = {}) {
  const id = `f${++fieldSeq}`;
  input.id = id;
  const label = h('label', { class: 'field__label', htmlFor: id, textContent: labelText });
  const value = h('span', { class: 'field__value' });
  const wrap = h('div', { class: className },
    h('div', { class: 'field__row' }, label, value), input);
  return { el: wrap, value, input };
}

function makeSceneChips() {
  const list = h('div', { class: 'chips' });
  const registry = new Map();
  const el = h('div', { class: 'scenes' },
    h('span', { class: 'scenes__label', textContent: 'Scenes' }), list);
  return {
    el,
    update(scenes) {
      el.hidden = scenes.length === 0;
      syncList(list, scenes, (s) => String(s.id), (scene) => {
        const btn = h('button', { class: 'chip', type: 'button' });
        let current = scene;
        btn.addEventListener('click', () => {
          call('activateScene', [current.id, { duration: transitionMs }]);
        });
        return {
          el: btn,
          update(next) {
            current = next;
            btn.textContent = next.name || 'Scene';
            btn.title = next.groupName ? `${next.name} — ${next.groupName}` : String(next.name || '');
          },
        };
      }, registry);
    },
  };
}

/* -------------------------------------------------------------- top bar */

const topbar = $('topbar');
const ui = {
  dot: $('status-dot'),
  bridgeName: $('bridge-name'),
  bridgeAddress: $('bridge-address'),
  bridgeModel: $('bridge-model'),
  bridgeSep: $('bridge-sep'),
  updateSep: $('update-sep'),
  bridgeUpdated: $('bridge-updated'),
  statusMessage: $('status-message'),
  manualForm: $('manual-form'),
  manualAddress: $('manual-address'),
  btnManual: $('btn-manual'),
  btnRescan: $('btn-rescan'),
  btnRefresh: $('btn-refresh'),
  btnForget: $('btn-forget'),
};

const STATUS_TEXT = {
  idle: 'Idle',
  searching: 'Searching the network',
  not_found: 'No bulbs found',
  connected: 'Connected',
  offline: 'Bulb offline',
  error: 'Error',
};

/** `bridge.address` carries every online bulb, so keep one line's worth on screen. */
function formatAddress(address) {
  const list = String(address).split(',').map((a) => a.trim()).filter(Boolean);
  if (list.length <= 1) return { text: list[0] || '\u2014', title: list[0] || '' };
  return { text: `${list[0]} +${list.length - 1} more`, title: list.join('\n') };
}

function renderTopbar(s) {
  ui.dot.dataset.status = s.status;
  ui.dot.title = STATUS_TEXT[s.status] || s.status;
  ui.dot.setAttribute('aria-label', ui.dot.title);
  topbar.classList.toggle('is-scanning', s.scanning);

  const b = s.bridge;
  ui.bridgeName.textContent = (b && b.name) || (b ? 'WiZ bulb' : 'No bulbs found');
  ui.bridgeName.title = b && b.id ? `Bulb id ${b.id}` : '';
  const addr = b && b.address ? formatAddress(b.address) : { text: '\u2014', title: '' };
  ui.bridgeAddress.textContent = addr.text;
  ui.bridgeAddress.title = addr.title;

  const model = b ? [b.modelid, b.swversion].filter(Boolean).join(' \u00b7 ') : '';
  ui.bridgeModel.textContent = model;
  ui.bridgeModel.title = model
    ? `Module ${b.modelid || 'unknown'} \u00b7 firmware ${b.swversion || 'unknown'}`
    : '';
  ui.bridgeSep.hidden = !model;

  ui.statusMessage.textContent = s.message || STATUS_TEXT[s.status] || '';
  ui.btnRefresh.disabled = !api || s.status !== 'connected';
  ui.btnForget.disabled = !api || !b;
  ui.btnRescan.disabled = !api;
  ui.btnManual.disabled = !api;
  ui.manualAddress.disabled = !api;
  renderAgo();
}

function renderAgo() {
  /* "3s ago" is only meaningful about a bridge we are actually talking to */
  const t = state.bridge ? state.lastUpdate : 0;
  if (!t) {
    ui.bridgeUpdated.textContent = '';
    ui.updateSep.hidden = true;
    return;
  }
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  ui.bridgeUpdated.textContent = secs < 2 ? 'just now'
    : secs < 60 ? `${secs}s ago`
      : `${Math.round(secs / 60)}m ago`;
  ui.updateSep.hidden = !ui.bridgeModel.textContent;
}

ui.btnRescan.addEventListener('click', () => call('discover', [{ force: true }]));
ui.btnRefresh.addEventListener('click', () => call('refresh'));
ui.btnForget.addEventListener('click', () => call('forget'));
ui.manualForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = ui.manualAddress.value.trim();
  if (!value) {
    toast('Enter a bulb address, for example 192.168.1.146', 'info');
    ui.manualAddress.focus();
    return;
  }
  call('connect', [value]);
});

/* ------------------------------------------------------- discovery view */

const dv = {
  view: $('view-discovery'),
  title: $('discovery-title'),
  copy: $('discovery-copy'),
  list: $('candidate-list'),
  count: $('candidate-count'),
  empty: $('candidate-empty'),
  scanAgain: $('btn-scan-again'),
  connectBest: $('btn-connect-best'),
};

const DISCOVERY_COPY = {
  idle: ['Ready to look for your bulbs',
    'Discovery starts automatically. You can also type a bulb address into the bar above.'],
  searching: ['Looking for your WiZ bulbs',
    'Broadcasting a registration probe on UDP 38899 and unicast-probing the local subnet.'],
  not_found: ['No bulbs answered yet',
    'Nothing on this network replied on UDP 38899. Probing keeps running, and because bulbs are '
    + 'matched by MAC address, one that reappears at a different IP is recognised straight away.'],
  offline: ['Lost contact with the bulbs',
    'No more replies on UDP 38899. A power cycle or a new DHCP lease is enough to explain it — '
    + 'the bulbs are picked up again automatically once they answer.'],
  error: ['Discovery hit a problem',
    'The message above has the detail. Rescan, or connect directly by address.'],
};

const SOURCE_TITLE = {
  cache: 'Address remembered from the last session',
  mdns: 'Announced itself on the local network',
  cloud: 'Reported by the vendor discovery service',
  sweep: 'Answered a UDP 38899 probe of the local subnet',
  manual: 'Entered by hand',
};

const candidateNodes = new Map();

dv.scanAgain.addEventListener('click', () => call('discover', [{ force: true }]));
dv.connectBest.addEventListener('click', () => call('connect', []));

function renderDiscovery(s) {
  const [title, copy] = DISCOVERY_COPY[s.status] || DISCOVERY_COPY.searching;
  dv.title.textContent = title;
  dv.copy.textContent = copy;
  dv.view.classList.toggle('is-scanning', s.scanning);
  dv.scanAgain.disabled = !api || s.scanning;
  dv.connectBest.disabled = !api || s.candidates.length === 0;
  dv.count.textContent = String(s.candidates.length);
  dv.empty.hidden = s.candidates.length > 0;

  syncList(dv.list, s.candidates, (c) => `${c.address}`, () => {
    const addr = h('span', { class: 'cand__addr' });
    const name = h('span', { class: 'cand__name' });
    const source = h('span', { class: 'badge badge--src' });
    const reach = h('span', { class: 'cand__reach' });
    const reachDot = h('span', { class: 'dot' });
    const btn = h('button', { class: 'btn btn--primary btn--tiny', type: 'button', textContent: 'Connect' });
    const li = h('li', { class: 'cand' }, addr, name, source,
      h('span', { class: 'cand__spacer' }), reach, btn);
    reach.append(reachDot, h('span', { textContent: '' }));
    let current = null;
    btn.addEventListener('click', () => {
      if (current) call('connect', [current.address]);
    });
    return {
      el: li,
      update(c) {
        current = c;
        addr.textContent = c.address;
        name.textContent = c.name || (c.id ? c.id : '');
        source.textContent = c.source || 'unknown';
        source.title = SOURCE_TITLE[c.source] || 'Source unknown';
        reachDot.dataset.status = c.reachable ? 'connected' : 'offline';
        reach.lastChild.textContent = c.reachable ? 'reachable' : 'no answer';
        btn.disabled = !api;
      },
    };
  }, candidateNodes);
}


/* ------------------------------------------------------- dashboard view */

const dash = {
  view: $('view-dashboard'),
  summary: $('dash-summary'),
  empty: $('dash-empty'),
  sections: $('sections'),
  zonesStrip: $('zones-strip'),
  zonesList: $('zones-list'),
  globalScenes: $('global-scenes'),
  seg: $('transition-seg'),
};

dash.seg.addEventListener('click', (event) => {
  const btn = event.target.closest('.seg__btn');
  if (!btn) return;
  transitionMs = Number(btn.dataset.ms);
  for (const b of dash.seg.querySelectorAll('.seg__btn')) {
    const active = b === btn;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
});
for (const b of dash.seg.querySelectorAll('.seg__btn')) {
  b.setAttribute('aria-pressed', b.classList.contains('is-active') ? 'true' : 'false');
}

/* one wheel instance, re-parented into whichever card has its picker open */
let wheel = null;
let openColor = null;

function getWheel() {
  if (!wheel) {
    wheel = createWheel({
      size: 168,
      onPick: (hex, { final }) => {
        if (!openColor) return;
        openColor.onPick(hex, final);
      },
    });
  }
  return wheel;
}

function closeColor() {
  if (!openColor) return;
  openColor.close();
  openColor = null;
}

/* -------- light card -------- */

function createLightCard(light) {
  const id = light.id;
  const swatch = h('span', { class: 'swatch' });
  const name = h('h3', { class: 'card__name' });
  const chips = h('div', { class: 'card__chips' });
  const power = makeSwitch('Power');
  const head = h('div', { class: 'card__head' },
    swatch, name, chips, h('div', { class: 'card__head-spacer' }), power);

  const bri = makeField('Brightness', h('input', {
    type: 'range', min: '0', max: '100', step: '1', value: '0',
  }));
  const ct = makeField('Temperature', h('input', {
    class: 'range--ct', type: 'range', min: '2000', max: '6500', step: '50', value: '2700',
  }));

  const colorBtn = h('button', {
    class: 'btn btn--tiny', type: 'button', 'aria-expanded': 'false',
  }, h('span', { class: 'swatch' }), h('span', { textContent: 'Color' }));
  const hexInput = h('input', {
    class: 'input input--mono', type: 'text', spellcheck: false, placeholder: '#rrggbb',
    'aria-label': 'Hex color',
  });
  const hexApply = h('button', { class: 'btn btn--tiny', type: 'button', textContent: 'Apply' });
  const mount = h('div', { class: 'color__mount' });
  const colorPanel = h('div', { class: 'color', hidden: true },
    mount, h('div', { class: 'color__row' }, hexInput, hexApply));

  const effect = h('select', { class: 'input', 'aria-label': 'Effect' });
  const identify = h('button', { class: 'btn btn--tiny', type: 'button', textContent: 'Identify' });
  const foot = h('div', { class: 'card__foot' }, colorBtn, effect, identify);

  const el = h('article', { class: 'card', dataset: { light: id } },
    head, bri.el, ct.el, colorPanel, foot);

  let current = light;
  let effectSignature = '';
  let ctSignature = '';
  let labelledFor = null;

  power.addEventListener('click', () => {
    const next = !current.on;
    setSwitch(power, next);
    setLight(id, withDuration({ on: next }));
  });

  bindRange(bri.input, `bri:${id}`, (value) => {
    bri.value.textContent = `${value}%`;
    setLight(id, withDuration({ bri: value, on: value > 0 && !current.on ? true : undefined }));
  });

  bindRange(ct.input, `ct:${id}`, (value) => {
    ct.value.textContent = `${value} K`;
    setLight(id, withDuration({ kelvin: value }));
  });

  let sentHex = null;
  const pushHex = throttle((hex) => {
    sentHex = hex;
    setLight(id, withDuration({ hex }));
  }, 120);

  function applyHex(raw) {
    const hex = normalizeHex(raw);
    if (!hex) {
      toast(`"${raw}" is not a hex color — use #rrggbb`, 'info');
      hexInput.value = current.hex || '';
      return;
    }
    /* explicit entry always writes, even if it repeats the last colour */
    pushHex.cancel();
    sentHex = hex;
    hexInput.value = hex;
    setLight(id, withDuration({ hex }));
  }

  const colorTarget = {
    onPick(hex, final) {
      editTouch(`hex:${id}`);
      hexInput.value = hex;
      if (!final) {
        pushHex(hex);
        return;
      }
      pushHex.cancel();
      if (hex === sentHex) return; /* the drag already delivered this colour */
      sentHex = hex;
      setLight(id, withDuration({ hex }));
    },
    close() {
      colorPanel.hidden = true;
      colorBtn.setAttribute('aria-expanded', 'false');
      if (wheel && wheel.el.parentNode === mount) wheel.el.remove();
    },
  };

  colorBtn.addEventListener('click', () => {
    if (openColor === colorTarget) { closeColor(); return; }
    closeColor();
    openColor = colorTarget;
    colorPanel.hidden = false;
    colorBtn.setAttribute('aria-expanded', 'true');
    const w = getWheel();
    mount.append(w.el);
    if (current.hex) w.setColor(current.hex);
    w.el.focus({ preventScroll: true });
  });

  hexApply.addEventListener('click', () => applyHex(hexInput.value));
  hexInput.addEventListener('focus', () => editStart(`hex:${id}`));
  hexInput.addEventListener('blur', () => editEnd(`hex:${id}`));
  hexInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyHex(hexInput.value);
  });

  effect.addEventListener('change', () => setLight(id, { effect: effect.value }));
  identify.addEventListener('click', () => call('identify', [id]));

  return {
    el,
    destroy() {
      if (openColor === colorTarget) { colorTarget.close(); openColor = null; }
    },
    update(next) {
      current = next;
      const caps = next.caps || {};
      const reachable = next.reachable !== false;
      const tint = next.hex
        || (next.mirek ? kelvinToHex(mirekToKelvin(next.mirek)) : null)
        || '#ffc98a';

      el.style.setProperty('--tint', tint);
      el.classList.toggle('is-on', Boolean(next.on));
      el.classList.toggle('is-unreachable', !reachable);

      if (labelledFor !== next.name) {
        labelledFor = next.name;
        const label = next.name || 'Light';
        name.textContent = label;
        /* archetype is per-bulb trivia: a tooltip, not a badge on every card */
        name.title = next.archetype ? `${label} \u2014 ${titleize(next.archetype)}` : label;
        power.setAttribute('aria-label', `Power for ${label}`);
        bri.input.setAttribute('aria-label', `Brightness for ${label}`);
        ct.input.setAttribute('aria-label', `Colour temperature for ${label}`);
        hexInput.setAttribute('aria-label', `Hex colour for ${label}`);
        colorBtn.setAttribute('aria-label', `Colour picker for ${label}`);
        effect.setAttribute('aria-label', `Effect for ${label}`);
        identify.setAttribute('aria-label', `Identify ${label}`);
      }
      setSwitch(power, Boolean(next.on));
      power.disabled = !reachable;

      if (chips.dataset.sig !== String(reachable)) {
        chips.dataset.sig = String(reachable);
        chips.textContent = '';
        if (!reachable) {
          chips.append(h('span', { class: 'badge badge--warn', textContent: 'unreachable' }));
        }
      }

      /* brightness */
      const dimmable = caps.dimming && next.bri !== null && next.bri !== undefined;
      bri.el.hidden = !dimmable;
      if (dimmable) {
        const value = Math.round(clamp(Number(next.bri) || 0, 0, 100));
        syncRange(bri.input, `bri:${id}`, value);
        if (!editing(`bri:${id}`)) bri.value.textContent = `${value}%`;
        bri.input.disabled = !reachable;
        bri.el.classList.toggle('is-off', !next.on);
      }

      /* colour temperature */
      ct.el.hidden = !caps.ct;
      if (caps.ct) {
        const mirekMin = Number(next.mirekMin) || 153;
        const mirekMax = Number(next.mirekMax) || 500;
        const warmK = mirekToKelvin(mirekMax);
        const coolK = mirekToKelvin(mirekMin);
        const sig = `${warmK}-${coolK}`;
        if (ctSignature !== sig) {
          ctSignature = sig;
          ct.input.min = String(warmK);
          ct.input.max = String(coolK);
          ct.input.style.setProperty('--ct-gradient', kelvinGradient(warmK, coolK));
        }
        const kelvin = next.mirek ? clamp(mirekToKelvin(next.mirek), warmK, coolK) : warmK;
        syncRange(ct.input, `ct:${id}`, kelvin);
        if (!editing(`ct:${id}`)) ct.value.textContent = `${kelvin} K`;
        ct.input.style.setProperty('--thumb', kelvinToHex(kelvin));
        ct.input.disabled = !reachable;
        ct.el.classList.toggle('is-off', !next.on);
      }

      /* colour */
      colorBtn.hidden = !caps.color;
      colorBtn.disabled = !caps.color || !reachable;
      if (!caps.color && openColor === colorTarget) closeColor();
      if (caps.color) {
        colorBtn.firstChild.style.background = tint;
        if (!editing(`hex:${id}`)) hexInput.value = next.hex || '';
        if (openColor === colorTarget && next.hex && !editing(`hex:${id}`)) {
          getWheel().setColor(next.hex);
        }
      }

      /* effects */
      const effects = caps.effects && Array.isArray(next.effects) ? next.effects : [];
      effect.hidden = effects.length === 0;
      if (effects.length) {
        const sig = effects.join('|');
        if (effectSignature !== sig) {
          effectSignature = sig;
          effect.textContent = '';
          for (const name2 of effects) {
            effect.append(h('option', { value: name2, textContent: titleize(name2) }));
          }
        }
        const value = next.effect && effects.includes(next.effect) ? next.effect : effects[0];
        if (effect.value !== value) effect.value = value;
        effect.disabled = !reachable;
      }

      identify.hidden = !caps.identify;
      identify.disabled = !reachable;
    },
  };
}

/* -------- room section -------- */

function createSection(entry) {
  const title = h('h2');
  const kindBadge = h('span', { class: 'badge' });
  const count = h('span', { class: 'group__count' });
  const power = makeSwitch('Power');
  const master = makeField('Brightness', h('input', {
    class: 'group__slider', type: 'range', min: '0', max: '100', step: '1', value: '0',
  }));
  master.el.classList.add('group__master');
  const blink = h('button', { class: 'btn btn--tiny', type: 'button', textContent: 'Blink' });
  const ctrls = h('div', { class: 'group__ctrls' }, master.el, blink, power);
  const head = h('div', { class: 'group__head' },
    h('div', { class: 'group__title' }, title, kindBadge, count), ctrls);
  const scenes = makeSceneChips();
  const cards = h('div', { class: 'cards' });
  const el = h('section', { class: 'group' }, head, scenes.el, cards);

  const cardNodes = new Map();
  let group = entry.group;

  power.addEventListener('click', () => {
    if (!group) return;
    const next = !group.on;
    setSwitch(power, next);
    setGroup(group.id, withDuration({ on: next }));
  });
  blink.addEventListener('click', () => {
    if (group) setGroup(group.id, { alert: 'breathe' });
  });
  bindRange(master.input, `gbri:${entry.key}`, (value) => {
    master.value.textContent = `${value}%`;
    if (group) {
      setGroup(group.id, withDuration({ bri: value, on: value > 0 && !group.on ? true : undefined }));
    }
  });

  return {
    el,
    destroy() {
      for (const node of cardNodes.values()) if (node.destroy) node.destroy();
    },
    update(next) {
      group = next.group;
      title.textContent = next.title;
      kindBadge.hidden = !group;
      if (group) kindBadge.textContent = group.kind || 'group';
      const n = next.lights.length;
      count.textContent = `${n} ${n === 1 ? 'light' : 'lights'}`;
      ctrls.hidden = !group;
      if (group) {
        setSwitch(power, Boolean(group.on));
        const label = group.name || next.title;
        blink.title = `Flash every light in ${label}`;
        blink.setAttribute('aria-label', `Flash every light in ${label}`);
        power.setAttribute('aria-label', `Power for ${label}`);
        master.input.setAttribute('aria-label', `Brightness for ${label}`);
        const key = `gbri:${next.key}`;
        const hasBri = group.bri !== null && group.bri !== undefined;
        master.el.hidden = !hasBri;
        if (hasBri) {
          const value = Math.round(clamp(Number(group.bri) || 0, 0, 100));
          syncRange(master.input, key, value);
          if (!editing(key)) master.value.textContent = `${value}%`;
        }
      }
      scenes.update(next.scenes);
      syncList(cards, next.lights, (l) => String(l.id), createLightCard, cardNodes);
    },
  };
}

/* -------- zone row -------- */

function createZoneRow(entry) {
  const name = h('span', { class: 'zone__name' });
  const badge = h('span', { class: 'badge' });
  const power = makeSwitch('Power');
  const slider = h('input', {
    class: 'zone__slider', type: 'range', min: '0', max: '100', step: '1', value: '0',
    'aria-label': 'Zone brightness',
  });
  const scenes = makeSceneChips();
  const el = h('div', { class: 'zone' },
    h('div', { class: 'zone__head' }, name, badge, h('span', { class: 'zone__spacer' }), power),
    slider, scenes.el);

  let group = entry.group;
  power.addEventListener('click', () => {
    const next = !group.on;
    setSwitch(power, next);
    setGroup(group.id, withDuration({ on: next }));
  });
  bindRange(slider, `zbri:${entry.key}`, (value) => {
    setGroup(group.id, withDuration({ bri: value, on: value > 0 && !group.on ? true : undefined }));
  });

  return {
    el,
    update(next) {
      group = next.group;
      name.textContent = group.name || 'Zone';
      badge.textContent = group.kind || 'group';
      power.setAttribute('aria-label', `Power for ${group.name || 'zone'}`);
      setSwitch(power, Boolean(group.on));
      const hasBri = group.bri !== null && group.bri !== undefined;
      slider.hidden = !hasBri;
      if (hasBri) {
        slider.setAttribute('aria-label', `Brightness for ${group.name || 'zone'}`);
        syncRange(slider, `zbri:${next.key}`, Math.round(clamp(Number(group.bri) || 0, 0, 100)));
      }
      scenes.update(next.scenes);
    },
  };
}

/* -------- layout -------- */

function buildLayout(s) {
  const byId = new Map(s.lights.map((l) => [String(l.id), l]));
  const scenesFor = new Map();
  const looseScenes = [];
  const groupIds = new Set(s.groups.map((g) => String(g.id)));
  for (const scene of s.scenes) {
    const gid = scene.groupId === null || scene.groupId === undefined ? null : String(scene.groupId);
    if (gid && groupIds.has(gid)) {
      if (!scenesFor.has(gid)) scenesFor.set(gid, []);
      scenesFor.get(gid).push(scene);
    } else {
      looseScenes.push(scene);
    }
  }

  const placed = new Set();
  const sections = [];
  for (const room of s.groups.filter((g) => g.kind === 'room').sort(byName)) {
    const lights = [];
    for (const lid of Array.isArray(room.lightIds) ? room.lightIds : []) {
      const light = byId.get(String(lid));
      if (!light || placed.has(String(light.id))) continue;
      placed.add(String(light.id));
      lights.push(light);
    }
    if (!lights.length) continue;
    sections.push({
      key: `room:${room.id}`,
      title: room.name || 'Room',
      group: room,
      lights: lights.sort(byName),
      scenes: scenesFor.get(String(room.id)) || [],
    });
  }

  /* lights the bridge did not put in a room group: bucket by reported room name */
  const buckets = new Map();
  for (const light of s.lights) {
    if (placed.has(String(light.id))) continue;
    const key = light.room || '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(light);
  }
  const bucketKeys = [...buckets.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });
  for (const key of bucketKeys) {
    sections.push({
      key: key ? `name:${key}` : 'other',
      title: key || 'Other lights',
      group: null,
      lights: buckets.get(key).sort(byName),
      scenes: [],
    });
  }

  const zones = s.groups.filter((g) => g.kind !== 'room').sort(byName).map((group) => ({
    key: `zone:${group.id}`,
    group,
    scenes: scenesFor.get(String(group.id)) || [],
  }));

  return { sections, zones, looseScenes };
}

const sectionNodes = new Map();
const zoneNodes = new Map();
const globalScenes = makeSceneChips();
dash.globalScenes.append(globalScenes.el);

function renderDashboard(s) {
  const { sections, zones, looseScenes } = buildLayout(s);
  const on = s.lights.filter((l) => l.on).length;
  const rooms = sections.filter((x) => x.group).length;
  const bits = [`${on} of ${s.lights.length} ${s.lights.length === 1 ? 'light' : 'lights'} on`];
  if (rooms) bits.push(`${rooms} ${rooms === 1 ? 'room' : 'rooms'}`);
  if (zones.length) bits.push(`${zones.length} ${zones.length === 1 ? 'zone' : 'zones'}`);
  if (s.scenes.length) bits.push(`${s.scenes.length} ${s.scenes.length === 1 ? 'scene' : 'scenes'}`);
  dash.summary.textContent = bits.join(' \u00b7 ');

  dash.empty.hidden = s.lights.length > 0;
  dash.zonesStrip.hidden = zones.length === 0;
  globalScenes.update(looseScenes);
  dash.globalScenes.hidden = looseScenes.length === 0;

  syncList(dash.zonesList, zones, (z) => z.key, createZoneRow, zoneNodes);
  syncList(dash.sections, sections, (x) => x.key, createSection, sectionNodes);
}

/* --------------------------------------------------------------- routing */

const views = {
  discovery: dv.view,
  dashboard: dash.view,
};

/* WiZ bulbs need no pairing: either we are talking to them, or we are looking for them. */
function viewFor(status) {
  return status === 'connected' ? 'dashboard' : 'discovery';
}

let activeView = null;

function render(next) {
  state = next;
  renderTopbar(state);

  const want = viewFor(state.status);
  if (want !== activeView) {
    activeView = want;
    for (const [key, el] of Object.entries(views)) el.hidden = key !== want;
    if (want !== 'dashboard') closeColor();
  }
  if (want === 'discovery') renderDiscovery(state);
  else renderDashboard(state);
}

/* ------------------------------------------------------------ bootstrap */

async function boot() {
  if (!api) {
    /* index.html ships with the banner visible, so nothing to add here — just
       show the (inert) discovery view so the window is not an empty shell. */
    render(emptyState());
    return;
  }
  document.documentElement.classList.add('hue-ready');
  render(normalizeState(await api.getState()));
  api.onState((pushed) => render(normalizeState(pushed)));
  setInterval(renderAgo, 1000);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeColor();
  });
}

boot().catch((err) => {
  toast((err && err.message) || 'Renderer failed to start');
});
