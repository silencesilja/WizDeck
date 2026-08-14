#!/usr/bin/env node
/**
 * Generates build/icon.icns (and icon.png) with no image dependencies:
 * rasterise RGBA by hand -> PNG via zlib -> .iconset via sips -> .icns via iconutil.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, 'build');
const SIZE = 1024;

/* ------------------------------------------------------------------ raster */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const c = SIZE / 2;
  const radius = SIZE * 0.2237; // macOS squircle-ish corner radius
  const inset = SIZE * 0.055;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;

      // Rounded-rect mask with antialiased edge.
      const dx = Math.max(inset + radius - x, 0, x - (SIZE - inset - radius));
      const dy = Math.max(inset + radius - y, 0, y - (SIZE - inset - radius));
      const dist = Math.hypot(dx, dy);
      const alpha = 1 - smooth(radius - 1.5, radius + 1.5, dist);
      if (alpha <= 0) continue;

      // Base: near-black vertical gradient, slightly warm at the bottom.
      const v = y / SIZE;
      let r = mix(24, 15, v);
      let g = mix(27, 17, v);
      let b = mix(34, 21, v);

      // Warm bulb glow, offset up-left like the in-app mark.
      const gx = x - c * 0.98;
      const gy = y - c * 0.92;
      const gd = Math.hypot(gx, gy) / (SIZE * 0.42);
      const glow = Math.exp(-gd * gd * 3.2);
      r = mix(r, 242, glow * 0.92);
      g = mix(g, 168, glow * 0.86);
      b = mix(b, 60, glow * 0.74);

      // Hot core.
      const core = 1 - smooth(SIZE * 0.1, SIZE * 0.132, Math.hypot(x - c * 0.98, y - c * 0.92));
      r = mix(r, 255, core);
      g = mix(g, 236, core);
      b = mix(b, 196, core);

      // Top-edge sheen so the tile does not read flat.
      const sheen = (1 - smooth(0, SIZE * 0.5, y)) * 0.06;
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

function toPng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- main */

mkdirSync(build, { recursive: true });
const png = path.join(build, 'icon.png');
writeFileSync(png, toPng(render()));
console.log(`wrote ${png}`);

const iconset = path.join(build, 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]) {
  execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, name)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(build, 'icon.icns')]);
rmSync(iconset, { recursive: true, force: true });
console.log(`wrote ${path.join(build, 'icon.icns')}`);
