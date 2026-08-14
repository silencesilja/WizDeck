/* Color math + canvas hue/saturation wheel. No dependencies, no network. */

const TAU = Math.PI * 2;

export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** h,s,v in 0..1 -> [r,g,b] in 0..255 */
export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** r,g,b in 0..255 -> { h, s, v } in 0..1 */
export function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function rgbToHex(r, g, b) {
  const to = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** '#rgb' | '#rrggbb' (with or without '#') -> [r,g,b] 0..255, or null */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  return null;
}

export function normalizeHex(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : null;
}

/** Blackbody approximation (Tanner Helland). kelvin 1000..40000 -> [r,g,b] */
export function kelvinToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

export function kelvinToHex(kelvin) {
  const [r, g, b] = kelvinToRgb(kelvin);
  return rgbToHex(r, g, b);
}

export function mirekToKelvin(mirek) {
  return Math.round(1e6 / clamp(mirek, 1, 1000));
}

export function kelvinToMirek(kelvin) {
  return Math.round(1e6 / clamp(kelvin, 1000, 40000));
}

/** CSS gradient across a kelvin range, warm (left) to cool (right). */
export function kelvinGradient(kFrom, kTo, stops = 10) {
  const parts = [];
  for (let i = 0; i < stops; i += 1) {
    const f = i / (stops - 1);
    parts.push(`${kelvinToHex(kFrom + (kTo - kFrom) * f)} ${Math.round(f * 100)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/**
 * Hue/saturation wheel. Value is always 1 — brightness lives on its own slider.
 * onPick(hex, { final }) fires while dragging (final: false) and on release (true).
 * Returns { el, setColor, hex } — a single instance can be re-parented between cards.
 */
export function createWheel({ size = 172, onPick } = {}) {
  const el = document.createElement('div');
  el.className = 'wheel';
  el.tabIndex = 0;
  el.setAttribute('role', 'application');
  el.setAttribute('aria-label', 'Color wheel: arrow keys change hue and saturation');
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;

  const canvas = document.createElement('canvas');
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  const px = Math.round(size * dpr);
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const marker = document.createElement('div');
  marker.className = 'wheel__marker';

  el.append(canvas, marker);

  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const radius = px / 2;
  for (let y = 0; y < px; y += 1) {
    const dy = y - radius + 0.5;
    for (let x = 0; x < px; x += 1) {
      const dx = x - radius + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const o = (y * px + x) * 4;
      const a = clamp(radius - d, 0, 1);
      if (a === 0) { data[o + 3] = 0; continue; }
      const h = ((Math.atan2(dy, dx) / TAU) + 1.25) % 1;
      const [r, g, b] = hsvToRgb(h, clamp(d / (radius - 1), 0, 1), 1);
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  let hue = 0;
  let sat = 0;

  function currentHex() {
    const [r, g, b] = hsvToRgb(hue, sat, 1);
    return rgbToHex(r, g, b);
  }

  function paintMarker() {
    const angle = (hue - 0.25) * TAU;
    const r = sat * 0.5;
    marker.style.left = `${(0.5 + Math.cos(angle) * r) * 100}%`;
    marker.style.top = `${(0.5 + Math.sin(angle) * r) * 100}%`;
    marker.style.background = currentHex();
  }

  function emit(final) {
    paintMarker();
    if (onPick) onPick(currentHex(), { final });
  }

  function pickFromEvent(event, final) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = event.clientX - rect.left - cx;
    const dy = event.clientY - rect.top - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    hue = ((Math.atan2(dy, dx) / TAU) + 1.25) % 1;
    sat = clamp(d / cx, 0, 1);
    emit(final);
  }

  el.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    el.focus({ preventScroll: true });
    el.classList.add('is-dragging');
    el.setPointerCapture(event.pointerId);
    pickFromEvent(event, false);
  });
  el.addEventListener('pointermove', (event) => {
    if (el.hasPointerCapture(event.pointerId)) pickFromEvent(event, false);
  });
  el.addEventListener('pointerup', (event) => {
    if (!el.hasPointerCapture(event.pointerId)) return;
    el.releasePointerCapture(event.pointerId);
    el.classList.remove('is-dragging');
    pickFromEvent(event, true);
  });
  el.addEventListener('pointercancel', () => el.classList.remove('is-dragging'));

  el.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 4 : 1;
    switch (event.key) {
      case 'ArrowLeft':  hue = (hue - step / 72 + 1) % 1; break;
      case 'ArrowRight': hue = (hue + step / 72) % 1; break;
      case 'ArrowUp':    sat = clamp(sat + step * 0.05, 0, 1); break;
      case 'ArrowDown':  sat = clamp(sat - step * 0.05, 0, 1); break;
      default: return;
    }
    event.preventDefault();
    emit(false);
  });
  el.addEventListener('keyup', (event) => {
    if (event.key.startsWith('Arrow')) emit(true);
  });

  function setColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    // A dim bulb still has a hue; ignore v so the marker tracks chromaticity only.
    hue = hsv.s < 0.02 ? hue : hsv.h;
    sat = hsv.s;
    paintMarker();
  }

  paintMarker();
  return { el, setColor, get hex() { return currentHex(); } };
}
