#!/usr/bin/env node
/**
 * Builds WizDeck.app and installs it into /Applications so Spotlight and
 * Launchpad find it.
 *
 *   node tools/install-macos.mjs
 */
import { execFileSync } from 'node:child_process';
import { rmSync, cpSync } from 'node:fs';
import os from 'node:os';
import { packageApp } from './package.mjs';

if (process.platform !== 'darwin') {
  console.error('This installer targets macOS. Use tools/install-linux.mjs on Linux, or see the README for Windows.');
  process.exit(1);
}

const bundle = packageApp({ platform: 'darwin', arch: os.arch() === 'x64' ? 'x64' : 'arm64' });
const target = '/Applications/WizDeck.app';

console.log('==> install to /Applications');
// Quit a running copy first, otherwise the replace races the live bundle.
try {
  execFileSync('osascript', ['-e', 'tell application "WizDeck" to quit'], { stdio: 'ignore' });
} catch { /* not running */ }
rmSync(target, { recursive: true, force: true });
cpSync(bundle, target, { recursive: true, verbatimSymlinks: true });

// Make Spotlight index it immediately instead of whenever it next scans.
try {
  execFileSync('mdimport', [target], { stdio: 'inherit' });
} catch { /* indexing is best effort */ }

console.log(`\nInstalled ${target}`);
console.log('Spotlight: press Cmd+Space and type "WizDeck".');
