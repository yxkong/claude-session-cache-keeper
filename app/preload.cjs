const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cacheKeeper', Object.freeze({
  state: () => ipcRenderer.invoke('keeper:state'),
  save: (id, control) => ipcRenderer.invoke('keeper:save', { id, control }),
  install: () => ipcRenderer.invoke('keeper:install'),
  stopAll: () => ipcRenderer.invoke('keeper:stop-all'),
  copyReload: () => ipcRenderer.invoke('keeper:copy-reload'),
  openDocs: () => ipcRenderer.invoke('keeper:docs'),
  update: action => ipcRenderer.invoke('keeper:update',action),
  onShowUpdates: callback => { ipcRenderer.on('keeper:show-updates',()=>callback()); },
}));
