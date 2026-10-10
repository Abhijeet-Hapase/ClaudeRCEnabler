'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rc', {
  enableNow: () => ipcRenderer.invoke('enable-now'),
  setAuto: (on) => ipcRenderer.invoke('set-auto', on),
  setLogin: (on) => ipcRenderer.invoke('set-login', on),
  openLog: () => ipcRenderer.invoke('open-log'),
  refresh: () => ipcRenderer.invoke('refresh'),
  on: (channel, fn) => {
    if (['state', 'log', 'busy', 'init'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
