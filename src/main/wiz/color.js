'use strict';

/** Colour maths for WiZ: hex/RGB, CIE xy (for the UI contract) and mired/kelvin. */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const gamma = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);

function rgbToXy({ r, g, b }) {
  const R = gamma(r / 255);
  const G = gamma(g / 255);
  const B = gamma(b / 255);
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const sum = X + Y + Z;
  if (sum <= 0) return { x: 0.3127, y: 0.329 };
  return { x: +(X / sum).toFixed(4), y: +(Y / sum).toFixed(4) };
}

/** Tanner Helland's blackbody approximation: good enough for a UI swatch. */
function kelvinToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) };
}

const kelvinToMirek = (k) => Math.round(1e6 / clamp(k, 1000, 10000));
const mirekToKelvin = (m) => Math.round(1e6 / clamp(m, 100, 1000));

/** Scale a hex swatch by brightness so cards read as dim/bright. */
function shade(hex, pct) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const f = clamp(0.35 + (clamp(pct, 0, 100) / 100) * 0.65, 0, 1);
  return rgbToHex({ r: rgb.r * f, g: rgb.g * f, b: rgb.b * f });
}

module.exports = { clamp, hexToRgb, rgbToHex, rgbToXy, kelvinToRgb, kelvinToMirek, mirekToKelvin, shade };
