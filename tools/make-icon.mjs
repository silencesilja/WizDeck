#!/usr/bin/env node
/**
 * Generates build/icon.png, build/icon.icns and build/icon.ico with no image
 * dependencies and no platform tools: rasterise RGBA by hand -> PNG via zlib ->
 * pack those PNGs into ICNS/ICO containers. Runs identically on every OS, so a
 * macOS bundle can be built from Linux and a Windows one from macOS.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, 'build');

/* ------------------------------------------------------------------ raster */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size * 0.2237; // macOS squircle-ish corner radius
  const inset = size * 0.055;
  // Edge softness scales with the raster: a fixed 1.5px feather is a staircase
  // at 16px and a smear at 1024px.
  const aa = Math.max(size / 683, 0.55);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;

      // Rounded-rect mask with antialiased edge.
      const dx = Math.max(inset + radius - x, 0, x - (size - inset - radius));
      const dy = Math.max(inset + radius - y, 0, y - (size - inset - radius));
      const dist = Math.hypot(dx, dy);
      const alpha = 1 - smooth(radius - aa, radius + aa, dist);
      if (alpha <= 0) continue;

      // Base: near-black vertical gradient, slightly warm at the bottom.
      const v = y / size;
      let r = mix(24, 15, v);
      let g = mix(27, 17, v);
      let b = mix(34, 21, v);

      // Warm bulb glow, offset up-left like the in-app mark.
      const gx = x - c * 0.98;
      const gy = y - c * 0.92;
      const gd = Math.hypot(gx, gy) / (size * 0.42);
      const glow = Math.exp(-gd * gd * 3.2);
      r = mix(r, 242, glow * 0.92);
      g = mix(g, 168, glow * 0.86);
      b = mix(b, 60, glow * 0.74);

      // Hot core.
      const core = 1 - smooth(size * 0.1, size * 0.132, Math.hypot(x - c * 0.98, y - c * 0.92));
      r = mix(r, 255, core);
      g = mix(g, 236, core);
      b = mix(b, 196, core);

      // Top-edge sheen so the tile does not read flat.
      const sheen = (1 - smooth(0, size * 0.5, y)) * 0.06;
      r = mix(r, 255, sheen);
      g = mix(g, 255, sheen);
      b = mix(b, 255, sheen);

      px[i] = Math.round(clamp(r, 0, 255));
      px[i + 1] = Math.round(clamp(g, 0, 255));
      px[i + 2] = Math.round(clamp(b, 0, 255));
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/* --------------------------------------------------------------------- png */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Rendering each size from scratch beats downscaling: no resampler, and the
// small sizes keep a crisp edge.
const pngCache = new Map();
const pngAt = (size) => {
  let png = pngCache.get(size);
  if (!png) {
    png = toPng(render(size), size);
    pngCache.set(size, png);
  }
  return png;
};

/* -------------------------------------------------------------------- icns */

// OSType -> pixel size. ic04/ic05 cover the small Finder list sizes, ic07..ic10
// the plain 128/256/512/1024 slots, ic11..ic14 the @2x variants the Dock picks
// on Retina displays.
const ICNS_TYPES = [
  ['ic04', 16], ['ic05', 32], ['ic11', 32], ['ic12', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512],
  ['ic09', 512], ['ic10', 1024],
];

function toIcns() {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = pngAt(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/* --------------------------------------------------------------------- ico */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function toIco() {
  const images = ICO_SIZES.map(pngAt);
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((png, i) => {
    const size = ICO_SIZES[i];
    const at = 6 + 16 * i;
    dir[at] = size & 0xff; // 256 is encoded as 0
    dir[at + 1] = size & 0xff;
    dir[at + 2] = 0; // palette size
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([dir, ...images]);
}

/* -------------------------------------------------------------------- main */

mkdirSync(build, { recursive: true });
for (const [name, data] of [
  ['icon.png', pngAt(1024)],
  ['icon.icns', toIcns()],
  ['icon.ico', toIco()],
]) {
  const out = path.join(build, name);
  writeFileSync(out, data);
  console.log(`wrote ${out} (${(data.length / 1024).toFixed(0)} KB)`);
}
