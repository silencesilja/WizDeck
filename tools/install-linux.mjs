#!/usr/bin/env node
/**
 * Builds WizDeck and installs it for the current user so it shows up in the
 * desktop's application menu (GNOME Activities, KDE Kickoff, rofi, …).
 *
 *   node tools/install-linux.mjs
 *
 * Everything lands under ~/.local, so no root and no package manager.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { packageApp, root } from './package.mjs';

if (process.platform !== 'linux') {
  console.error('This installer targets Linux. Use tools/install-macos.mjs on macOS, or see the README for Windows.');
  process.exit(1);
}

const arch = os.arch() === 'x64' ? 'x64' : os.arch();
const bundle = packageApp({ platform: 'linux', arch });

const home = os.homedir();
const appDir = path.join(home, '.local', 'opt', 'WizDeck');
const iconDir = path.join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');
const desktopDir = path.join(home, '.local', 'share', 'applications');
const desktopFile = path.join(desktopDir, 'wizdeck.desktop');

console.log(`==> install to ${appDir}`);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(path.dirname(appDir), { recursive: true });
cpSync(bundle, appDir, { recursive: true, verbatimSymlinks: true });

console.log('==> desktop entry');
mkdirSync(iconDir, { recursive: true });
cpSync(path.join(root, 'build', 'icon.png'), path.join(iconDir, 'wizdeck.png'));

mkdirSync(desktopDir, { recursive: true });
writeFileSync(desktopFile, `[Desktop Entry]
Type=Application
Name=WizDeck
GenericName=WiZ Bulb Control
Comment=Local control for WiZ smart bulbs over UDP
Exec=${path.join(appDir, 'WizDeck')} %U
Icon=wizdeck
Terminal=false
Categories=Utility;
StartupWMClass=WizDeck
`);

// Best effort: some desktops only notice a new .desktop after a cache refresh.
for (const [cmd, args] of [
  ['update-desktop-database', [desktopDir]],
  ['gtk-update-icon-cache', ['-f', '-t', path.join(home, '.local', 'share', 'icons', 'hicolor')]],
]) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch { /* cache refresh is optional */ }
}

console.log(`\nInstalled ${appDir}`);
console.log(`Desktop entry ${desktopFile}`);
console.log('Search your launcher for "WizDeck".');
