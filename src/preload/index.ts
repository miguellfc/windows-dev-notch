import { contextBridge, ipcRenderer } from 'electron'
import { buildApi } from '../shared/ipc/build-api'

// The renderer only ever sees `window.notch`: one method per contract channel.
// Validation happens in the main process; nothing here trusts the caller.
contextBridge.exposeInMainWorld(
  'notch',
  buildApi((channel, input) => ipcRenderer.invoke(channel, input)),
)
