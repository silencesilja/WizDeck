'use strict';

const { contextBridge, ipcRenderer } = require('electron');


// The frameless window needs a platform hook so the CSS can reserve the
// macOS traffic-light gutter. Preload shares the DOM, not the page's JS world.
const setPlatform = () => document.documentElement.setAttribute('data-platform', process.platform);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setPlatform, { once: true });
else setPlatform();
contextBridge.exposeInMainWorld('hue', {
  getState: () => ipcRenderer.invoke('hue:getState'),
  discover: (opts) => ipcRenderer.invoke('hue:discover', opts || {}),
  pair: (address) => ipcRenderer.invoke('hue:pair', address || null),
  connect: (address) => ipcRenderer.invoke('hue:connect', address || null),
  forget: () => ipcRenderer.invoke('hue:forget'),
  setLight: (id, patch) => ipcRenderer.invoke('hue:setLight', id, patch || {}),
  setGroup: (id, patch) => ipcRenderer.invoke('hue:setGroup', id, patch || {}),
  activateScene: (id, opts) => ipcRenderer.invoke('hue:scene', id, opts || {}),
  identify: (id) => ipcRenderer.invoke('hue:identify', id),
  refresh: () => ipcRenderer.invoke('hue:refresh'),
  onState: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('hue:state', listener);
    return () => ipcRenderer.removeListener('hue:state', listener);
  },
});
