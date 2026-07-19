const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashApi', {
  onStatus: (callback) => ipcRenderer.on('docker-status', (_event, message) => callback(message)),
});
