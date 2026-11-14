import type { ChannelName } from '../../shared/ipc/channels'
import { DEFAULT_USAGE_RANGE } from '../../shared/usage/schema'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { UsageLog } from './usage-log'

type UsageChannel = Extract<ChannelName, `usage:${string}`>
type Guard = (event: IpcEventLike) => boolean

/** Waits for the log to finish loading so the first summary already includes the file. */
export const createUsageIpcHandlers = (
  usage: Pick<UsageLog, 'summary'>,
  ready: () => Promise<void> = () => Promise.resolve(),
): Pick<IpcHandlers, UsageChannel> => ({
  'usage:summary': async ({ days }) => {
    await ready()
    return usage.summary(days ?? DEFAULT_USAGE_RANGE)
  },
})

/** The usage summary is shown only on the Control Center's About page. */
export const usageChannelGuards = ({ fromControlCenter }: { fromControlCenter: Guard }): Record<UsageChannel, Guard> => ({
  'usage:summary': fromControlCenter,
})
