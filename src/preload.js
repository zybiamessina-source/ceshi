const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radar', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  listVideos: () => ipcRenderer.invoke('videos:list'),
  collectAuthor: (request) => ipcRenderer.invoke('author:collect', request),
  stopCollection: () => ipcRenderer.invoke('author:stop'),
  refreshStats: (ids) => ipcRenderer.invoke('videos:stats', ids),
  transcribe: (id) => ipcRenderer.invoke('videos:transcribe', id),
  searchLowFans: (query) => ipcRenderer.invoke('lowfans:search', query),
  listTopics: () => ipcRenderer.invoke('topics:list'),
  addTopic: (video) => ipcRenderer.invoke('topics:add', video),
  removeTopic: (id) => ipcRenderer.invoke('topics:remove', id),
  rewriteTopic: (id) => ipcRenderer.invoke('topics:rewrite', id),
  exportCsv: (rows, suggestedName) => ipcRenderer.invoke('export:csv', rows, suggestedName),
  clearData: () => ipcRenderer.invoke('data:clear'),
  onProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('task:progress', handler);
    return () => ipcRenderer.removeListener('task:progress', handler);
  }
});
