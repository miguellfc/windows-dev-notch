import type { ChannelName } from '../../shared/ipc/channels'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { SystemMonitor } from './system-monitor'

type SystemChannel = Extract<ChannelName, `system:${string}`>
type Guard = (event: IpcEventLike) => boolean

export const createSystemIpcHandlers = (
  monitor: Pick<SystemMonitor, 'setOrder' | 'kill'>,
): Pick<IpcHandlers, SystemChannel> => ({
  'system:view': ({ by }) => {
    monitor.setOrder(by)
    return null
  },
  'system:kill-process': (input) => monitor.kill(input),
})

/** The System view lives in the notch: no other window may drive sampling or close processes. */
export const systemChannelGuards = ({ fromNotch }: { fromNotch: Guard }): Record<SystemChannel, Guard> => ({
  'system:view': fromNotch,
  'system:kill-process': fromNotch,
})
