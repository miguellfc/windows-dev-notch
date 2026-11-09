import type { ChannelName } from '../../shared/ipc/channels'
import { contract, type ContractInput, type ContractOutput } from '../../shared/ipc/contract'
import { err, ok, type Result } from '../../shared/ipc/result'
import { urlForLog, type Logger } from '../services/logger'
import { ExposedIpcError } from './errors'

/** The parts of Electron's IPC we depend on; lets tests use a fake. */
export interface IpcEventLike {
  readonly sender: { readonly id: number }
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>): void
  removeHandler(channel: string): void
}

export type IpcHandlers = {
  readonly [C in ChannelName]: (input: ContractInput<C>) => ContractOutput<C> | Promise<ContractOutput<C>>
}

export interface RegisterIpcOptions {
  ipcMain: IpcMainLike
  handlers: IpcHandlers
  isTrustedUrl: (url: string) => boolean
  /** Extra sender checks for channels only one window may use (e.g. the terminal). */
  channelGuards?: Partial<Record<ChannelName, (event: IpcEventLike) => boolean>>
  logger: Logger
}

const describeIssues = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) =>
  issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')

/**
 * Registers one handler per contract channel. Each call is checked in order:
 * trusted top-level sender → valid input → handler → valid output.
 */
export function registerIpc({ ipcMain, handlers, isTrustedUrl, channelGuards = {}, logger }: RegisterIpcOptions): () => void {
  const log = logger.child('ipc')
  const channelNames = Object.keys(contract) as ChannelName[]

  for (const channel of channelNames) {
    const { input, output } = contract[channel]
    const handler = handlers[channel] as (value: unknown) => unknown

    ipcMain.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
      const frame = event.senderFrame
      if (!frame || frame.parent !== null || !isTrustedUrl(frame.url)) {
        log.warn('Rejected IPC from untrusted sender', { channel, url: urlForLog(frame?.url) })
        return err('FORBIDDEN', 'Untrusted sender')
      }
      const guard = channelGuards[channel]
      if (guard && !guard(event)) {
        log.warn('Rejected IPC from a window not allowed on this channel', { channel })
        return err('FORBIDDEN', 'Untrusted sender')
      }

      if (args.length > 1) return err('INVALID_INPUT', 'Expected at most one argument')
      const parsedInput = input.safeParse(args[0])
      if (!parsedInput.success) return err('INVALID_INPUT', describeIssues(parsedInput.error.issues))

      try {
        const parsedOutput = output.safeParse(await handler(parsedInput.data))
        if (!parsedOutput.success) {
          log.error('Handler returned data outside the contract', {
            channel,
            issues: describeIssues(parsedOutput.error.issues),
          })
          return err('INTERNAL', 'Unexpected error')
        }
        return ok(parsedOutput.data)
      } catch (error) {
        if (error instanceof ExposedIpcError) {
          log.warn('IPC handler refused the call', { channel, code: error.code })
          return err(error.code, error.message)
        }
        log.error('IPC handler failed', { channel, error })
        return err('INTERNAL', 'Unexpected error')
      }
    })
  }

  return () => {
    for (const channel of channelNames) ipcMain.removeHandler(channel)
  }
}
