'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { createEngine } = require('./wiz/engine.js');

// --- CLI flags: --bulb=<ip> pins a single bulb, --store=<path> relocates state ---
function flag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const forcedBulb = flag('bulb');
const storeOverride = flag('store');

/** @type {ReturnType<typeof createEngine>|null} */
let engine = null;
/** @type {BrowserWindow|null} */
let win = null;

function storePath() {
  if (typeof storeOverride === 'string' && storeOverride) return storeOverride;
  return path.join(app.getPath('userData'), 'wiz.json');
}

function pushState(state) {
  if (win && !win.isDestroyed()) win.webContents.send('hue:state', state);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0e1116',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Vertically centred in the 62px topbar (--topbar-h); the CSS reserves the gutter.
    trafficLightPosition: { x: 18, y: 22 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never let the renderer navigate away or spawn windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

function wireIpc() {
  const handlers = {
    'hue:getState': () => engine.getState(),
    'hue:discover': (_e, opts) => engine.discover(opts || {}),
    'hue:pair': (_e, address) => engine.pair(address || undefined),
    'hue:connect': (_e, address) => engine.connect(address || undefined),
    'hue:forget': () => engine.forget(),
    'hue:setLight': (_e, id, patch) => engine.setLight(id, patch || {}),
    'hue:renameLight': (_e, id, name) => engine.renameLight(id, name),
    'hue:setGroup': (_e, id, patch) => engine.setGroup(id, patch || {}),
    'hue:scene': (_e, id, opts) => engine.activateScene(id, opts || {}),
    'hue:identify': (_e, id) => engine.identify(id),
    'hue:refresh': () => engine.refresh(),
  };

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...args);
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        { role: 'editMenu' },
        {
          label: 'Lights',
          submenu: [
            { label: 'Rescan network', accelerator: 'CmdOrCtrl+R', click: () => engine && engine.discover({ force: true }) },
            { label: 'Refresh bulbs', accelerator: 'CmdOrCtrl+Shift+R', click: () => engine && engine.refresh() },
            { type: 'separator' },
            { label: 'Forget bulbs', click: () => engine && engine.forget() },
          ],
        },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ])
    );

    engine = createEngine({
      storePath: storePath(),
      onState: pushState,
      log: (...a) => console.log('[wiz]', ...a),
    });

    wireIpc();
    createWindow();

    if (typeof forcedBulb === 'string' && forcedBulb) {
      engine.connect(forcedBulb);
    } else {
      engine.start();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (engine) engine.dispose();
  });
}
