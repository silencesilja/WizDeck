#!/usr/bin/env node
/**
 * Builds a WizDeck application bundle with @electron/packager.
 *
 *   node tools/package.mjs                       # host platform + arch
 *   node tools/package.mjs --platform=win32      # cross-build for Windows
 *   node tools/package.mjs --platform=linux --arch=x64
 *
 * Also usable as a module: `import { packageApp } from './package.mjs'`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });

const has = (cmd) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const ICONS = { darwin: 'build/icon.icns', win32: 'build/icon.ico', linux: 'build/icon.png' };

/** Path of the bundle produced for a target, relative paths resolved from root. */
export function bundlePath(platform, arch, out = 'dist') {
  const dir = path.join(root, out, `WizDeck-${platform}-${arch}`);
  if (platform === 'darwin') return path.join(dir, 'WizDeck.app');
  return dir;
}

export function packageApp({
  platform = process.platform,
  arch = os.arch() === 'x64' ? 'x64' : 'arm64',
  out = 'dist',
} = {}) {
  if (!ICONS[platform]) throw new Error(`unsupported platform: ${platform}`);

  console.log('==> icon');
  run(process.execPath, [path.join(root, 'tools', 'make-icon.mjs')]);

  console.log(`==> package ${platform}-${arch}`);
  const bundle = bundlePath(platform, arch, out);
  rmSync(path.join(root, out, `WizDeck-${platform}-${arch}`), { recursive: true, force: true });

  // rcedit stamps the .exe icon and needs Wine when cross-building from a
  // non-Windows host; without it the build would abort, so drop the icon and say so.
  const iconUsable = platform !== 'win32' || process.platform === 'win32' || has('wine') || has('wine64');
  if (!iconUsable) {
    console.warn('    no wine found: building the .exe without its icon (build on Windows for the icon)');
  }

  run(path.join(root, 'node_modules', '.bin', 'electron-packager'), [
    '.', 'WizDeck',
    `--platform=${platform}`,
    `--arch=${arch}`,
    ...(iconUsable ? [`--icon=${ICONS[platform]}`] : []),
    `--out=${out}`,
    '--overwrite',
    '--app-bundle-id=dev.wizdeck.app',
    '--app-category-type=public.app-category.utilities',
    '--prune=true',
    '--ignore=^/dist',
    '--ignore=^/build',
    '--ignore=^/tools',
    '--ignore=^/\\.git',
  ]);

  if (!existsSync(bundle)) throw new Error(`packager did not produce ${bundle}`);

  // Editing the bundle invalidates Electron's signature; macOS (and Apple
  // silicon especially) refuses to launch it until it is signed again.
  if (platform === 'darwin' && process.platform === 'darwin') {
    console.log('==> ad-hoc codesign');
    run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
    run('codesign', ['--verify', '--deep', '--strict', bundle]);
  } else if (platform === 'darwin') {
    console.warn('    cross-built for macOS: run `codesign --force --deep --sign - WizDeck.app` on a Mac before launching');
  }

  return bundle;
}

const flag = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = packageApp({
    platform: flag('platform', process.platform),
    arch: flag('arch', os.arch() === 'x64' ? 'x64' : 'arm64'),
    out: flag('out', 'dist'),
  });
  console.log(`\nBuilt ${bundle}`);
}
