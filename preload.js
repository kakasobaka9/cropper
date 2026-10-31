const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cropperNative', {
  info: () => ipcRenderer.invoke('info'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  saveFiles: (folder, subfolder, files) => ipcRenderer.invoke('save-files', folder, subfolder, files),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  // каталог
  catalogLoad: () => ipcRenderer.invoke('catalog-load'),
  catalogSave: (data) => ipcRenderer.invoke('catalog-save', data),
  catalogSaveSync: (data) => ipcRenderer.sendSync('catalog-save-sync', data),
  catalogWrite: (name, data) => ipcRenderer.invoke('catalog-write', name, data),
  catalogSwitch: () => ipcRenderer.invoke('catalog-switch'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  trash: (p) => ipcRenderer.invoke('trash', p),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  setZoom: (f) => ipcRenderer.invoke('set-zoom', f),
});
