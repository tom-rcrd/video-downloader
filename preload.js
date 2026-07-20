const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  analyze: (url) => ipcRenderer.invoke('analyze', url),
  download: (opts) => ipcRenderer.invoke('download', opts),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  getCategories: () => ipcRenderer.invoke('get-categories'),
  saveCategory: (category) => ipcRenderer.invoke('save-category', category),
  deleteCategory: (id) => ipcRenderer.invoke('delete-category', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  listOllamaModels: () => ipcRenderer.invoke('list-ollama-models'),
  cleanDescription: (payload) => ipcRenderer.invoke('clean-description', payload),
  findCrossReference: (info) => ipcRenderer.invoke('find-cross-reference', info),
  extractVideoMetadata: (payload) => ipcRenderer.invoke('extract-video-metadata', payload),
  cancelCrossReference: () => ipcRenderer.send('cancel-cross-reference'),
  getDockerStatus: () => ipcRenderer.invoke('get-docker-status'),
  openDockerDownload: () => ipcRenderer.send('open-docker-download'),
  openOllamaDownload: () => ipcRenderer.send('open-ollama-download'),
  onDockerStatus: (callback) => ipcRenderer.on('docker-status', (_event, data) => callback(data)),
  onProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
});
