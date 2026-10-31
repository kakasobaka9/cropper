const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cropperNative', {
  info: () => ipcRenderer.invoke('info'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  saveFiles: (folder, subfolder, files) => ipcRenderer.invoke('save-files', folder, subfolder, files),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
});
