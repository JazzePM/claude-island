const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getUsage: (force) => ipcRenderer.invoke('get-usage', force),
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  menu: () => ipcRenderer.send('menu'),
  minimize: () => ipcRenderer.send('minimize'),
  setTray: (icons, tooltip) => ipcRenderer.send('tray-icon', icons, tooltip),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, p) => cb(p)),
  onCollapse: (cb) => ipcRenderer.on('collapse', () => cb()),
});
