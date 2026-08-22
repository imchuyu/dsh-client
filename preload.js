// preload.js — safe bridge between the Electron main process and the local
// error/loading pages. Runs in an isolated, sandboxed context. The live dsh web
// UI is loaded as a normal remote page and never sees this API.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshClient', {
  // error.html subscribes to this to render the failure reason + stderr tail.
  onErrorInfo: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('error-info', listener);
    return () => ipcRenderer.removeListener('error-info', listener);
  },
  // error.html buttons
  retry: () => ipcRenderer.send('client-retry'),
  quit: () => ipcRenderer.send('client-quit'),
});
