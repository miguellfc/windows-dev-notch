import type { ChannelName } from '../../shared/ipc/channels'
import { ExposedIpcError } from '../ipc/errors'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { ClaudeService } from './claude-service'

type ClaudeChannel = Extract<ChannelName, `claude:${string}`>
type Guard = (event: IpcEventLike) => boolean

export const createClaudeIpcHandlers = (service: ClaudeService): Pick<IpcHandlers, ClaudeChannel> => ({
  'claude:get-state': () => service.state(),
  'claude:decide': ({ requestId, decision }) => {
    if (!service.decide(requestId, decision)) throw new ExposedIpcError('NOT_FOUND', 'No pending request with that id')
    return null
  },
  'claude:focus-app': () => {
    service.focusApp()
    return null
  },
  'claude:dismiss-session': ({ sessionId }) => {
    if (!service.dismissSession(sessionId)) throw new ExposedIpcError('NOT_FOUND', 'No idle session with that id')
    return null
  },
  'claude:hooks-preview': () => service.previewHooks(),
  'claude:hooks-install': () => service.installHooks(),
  'claude:hooks-uninstall': () => service.uninstallHooks(),
  'claude:test-connection': () => service.testConnection(),
  'claude:rotate-token': () => service.rotateToken(),
  'claude:rotate-port': () => service.rotatePort(),
})

/** Decisions and session actions belong to the notch; hooks, token and port to the Control Center. */
export const claudeChannelGuards = ({
  fromNotch,
  fromControlCenter,
}: {
  fromNotch: Guard
  fromControlCenter: Guard
}): Record<ClaudeChannel, Guard> => ({
  'claude:get-state': (event) => fromNotch(event) || fromControlCenter(event),
  'claude:decide': fromNotch,
  'claude:focus-app': fromNotch,
  'claude:dismiss-session': fromNotch,
  'claude:hooks-preview': fromControlCenter,
  'claude:hooks-install': fromControlCenter,
  'claude:hooks-uninstall': fromControlCenter,
  'claude:test-connection': fromControlCenter,
  'claude:rotate-token': fromControlCenter,
  'claude:rotate-port': fromControlCenter,
})
