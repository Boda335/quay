const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('downloader', {
  getDefaults: () => ipcRenderer.invoke('app:defaults'),
  loadQueue: () => ipcRenderer.invoke('queue:load'),
  migrateLegacy: (data) => ipcRenderer.invoke('legacy:migrate', data),
  saveQueue: (tasks) => ipcRenderer.invoke('queue:save', tasks),
  removeTask: (id) => ipcRenderer.invoke('queue:remove', id),
  saveHistory: (entries) => ipcRenderer.invoke('history:save', entries),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  openFolder: (folder) => ipcRenderer.invoke('folder:open', folder),
  prepareEngine: () => ipcRenderer.invoke('engine:prepare'),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  clearArchive: () => ipcRenderer.invoke('archive:clear'),
  inspectSource: (url) => ipcRenderer.invoke('source:inspect', url),
  inspectSources: (urls) => ipcRenderer.invoke('source:inspect-batch', urls),
  run: (job) => ipcRenderer.invoke('download:run', job),
  cancel: (taskId) => ipcRenderer.invoke('download:cancel', taskId),
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  onProgress: on('download:progress'),
  onEngine: on('engine:state')
});
