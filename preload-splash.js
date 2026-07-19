const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashApi', {
  onStatus: (callback) => ipcRenderer.on('docker-status', (_event, data) => callback(data)),
  openDockerDownload: () => ipcRenderer.send('open-docker-download'),
});
