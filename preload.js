const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  analyze: (url) => ipcRenderer.invoke('analyze', url),
  download: (opts) => ipcRenderer.invoke('download', opts),
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
  cancelCrossReference: () => ipcRenderer.send('cancel-cross-reference'),
  onProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
});
