#!/usr/bin/env node
/**
 * Builds WizDeck.app and installs it into /Applications so Spotlight finds it.
 *
 *   node tools/install-macos.mjs            # build + install
 *   node tools/install-macos.mjs --no-install   # build into dist/ only
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });

if (process.platform !== 'darwin') {
  console.error('This installer targets macOS.');
  process.exit(1);
}

const arch = os.arch() === 'x64' ? 'x64' : 'arm64';
const dist = path.join(root, 'dist');
const bundle = path.join(dist, `WizDeck-darwin-${arch}`, 'WizDeck.app');
const target = '/Applications/WizDeck.app';

console.log('==> icon');
run(process.execPath, [path.join(root, 'tools', 'make-icon.mjs')]);

console.log('==> package');
rmSync(path.join(dist, `WizDeck-darwin-${arch}`), { recursive: true, force: true });
run(path.join(root, 'node_modules', '.bin', 'electron-packager'), [
  '.', 'WizDeck',
  '--platform=darwin',
  `--arch=${arch}`,
  '--icon=build/icon.icns',
  '--out=dist',
  '--overwrite',
  '--app-bundle-id=dev.wizdeck.app',
  '--app-category-type=public.app-category.utilities',
  '--prune=true',
  '--ignore=^/dist',
  '--ignore=^/build',
  '--ignore=^/tools',
  '--ignore=^/\\.git',
]);

if (!existsSync(bundle)) {
  console.error(`packager did not produce ${bundle}`);
  process.exit(1);
}

// Editing the bundle invalidates Electron's signature; ad-hoc re-sign so
// macOS will launch it (required on Apple silicon).
console.log('==> ad-hoc codesign');
run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
run('codesign', ['--verify', '--deep', '--strict', bundle]);

if (process.argv.includes('--no-install')) {
  console.log(`\nBuilt ${bundle}`);
  process.exit(0);
}

console.log('==> install to /Applications');
// Quit a running copy first, otherwise the replace races the live bundle.
try {
  execFileSync('osascript', ['-e', 'tell application "WizDeck" to quit'], { stdio: 'ignore' });
} catch (_) { /* not running */ }
rmSync(target, { recursive: true, force: true });
cpSync(bundle, target, { recursive: true, verbatimSymlinks: true });

// Make Spotlight index it immediately instead of whenever it next scans.
try {
  run('mdimport', [target]);
} catch (_) { /* indexing is best effort */ }

console.log(`\nInstalled ${target}`);
console.log('Spotlight: press Cmd+Space and type "WizDeck".');
