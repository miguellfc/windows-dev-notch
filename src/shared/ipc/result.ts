export type IpcErrorCode = 'INVALID_INPUT' | 'FORBIDDEN' | 'READ_ONLY' | 'INTERNAL'

export interface IpcError {
  readonly code: IpcErrorCode
  readonly message: string
}

/** Every IPC call resolves to a Result; handlers never throw across the bridge. */
export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError }

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })

export const err = (code: IpcErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
})
