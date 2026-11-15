const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getUsage: (force) => ipcRenderer.invoke('get-usage', force),
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  menu: () => ipcRenderer.send('menu'),
  minimize: () => ipcRenderer.send('minimize'),
  setTray: (icons, tooltip) => ipcRenderer.send('tray-icon', icons, tooltip),
  projects: () => ipcRenderer.invoke('projects'),
  openProject: (dir) => ipcRenderer.invoke('open-project', dir),
  dragBy: (dx, dy) => ipcRenderer.send('drag-by', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  isDetached: () => ipcRenderer.invoke('is-detached'),
  onDetached: (cb) => ipcRenderer.on('detached', (_e, on) => cb(on)),
  onProjectsChanged: (cb) => ipcRenderer.on('projects-changed', () => cb()),
  setSelected: (paths) => ipcRenderer.invoke('set-selected', paths),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, p) => cb(p)),
  onCollapse: (cb) => ipcRenderer.on('collapse', () => cb()),
});
