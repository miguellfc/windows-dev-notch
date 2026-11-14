// THROWAWAY M0 spike preload.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('spike', {
  request: (state) => ipcRenderer.send('request', state),
  hover: (inside) => ipcRenderer.send('hover', inside),
  settled: () => ipcRenderer.send('settled'),
  focusClaude: () => ipcRenderer.send('focus-claude'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onHook: (cb) => ipcRenderer.on('hook', (_e, hook) => cb(hook)),
})
