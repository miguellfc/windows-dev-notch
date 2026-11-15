const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('spike', {
  onHover: (callback) => ipcRenderer.on('hover', (_event, on) => callback(on)),
})
