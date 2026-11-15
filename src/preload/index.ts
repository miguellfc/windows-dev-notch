import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { buildApi } from '../shared/ipc/build-api'

// The renderer only ever sees `window.notch`: one method per contract channel plus
// `events.on` for the known push events. Validation happens in the main process.
contextBridge.exposeInMainWorld(
  'notch',
  buildApi(
    (channel, input) => ipcRenderer.invoke(channel, input),
    (channel, listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) => (listener as (value: unknown) => void)(payload)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
  ),
)
