import type { IpcErrorCode } from '../../shared/ipc/result'

/**
 * An error whose code and message are safe to show the renderer.
 * Any other exception crossing IPC is reported as a generic INTERNAL error.
 */
export class ExposedIpcError extends Error {
  readonly code: Exclude<IpcErrorCode, 'INTERNAL'>

  constructor(code: Exclude<IpcErrorCode, 'INTERNAL'>, message: string) {
    super(message)
    this.name = 'ExposedIpcError'
    this.code = code
  }
}
