import type { ChannelName } from '../../shared/ipc/channels'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { RedmineIntegration } from './redmine-integration'

type RedmineChannel = Extract<ChannelName, `redmine:${string}`>
type Guard = (event: IpcEventLike) => boolean

/** Every handler waits for the stored key to load, so the first state is never a guess. */
export const createRedmineIpcHandlers = (
  redmine: Pick<
    RedmineIntegration,
    | 'ready'
    | 'state'
    | 'issues'
    | 'issue'
    | 'activities'
    | 'updateIssue'
    | 'logTime'
    | 'summary'
    | 'setViewOpen'
    | 'refresh'
    | 'open'
    | 'setKey'
    | 'clear'
  >,
): Pick<IpcHandlers, RedmineChannel> => ({
  'redmine:get-state': async () => {
    await redmine.ready
    return redmine.state()
  },
  'redmine:issues': () => redmine.issues(),
  'redmine:issue': ({ id }) => redmine.issue(id),
  'redmine:activities': () => redmine.activities(),
  'redmine:update-issue': (input) => redmine.updateIssue(input),
  'redmine:log-time': (input) => redmine.logTime(input),
  'redmine:summary': () => redmine.summary(),
  'redmine:view': async ({ open }) => {
    await redmine.ready
    redmine.setViewOpen(open)
    return null
  },
  'redmine:refresh': async () => {
    await redmine.ready
    redmine.refresh()
    return null
  },
  'redmine:open': async ({ id }) => {
    await redmine.ready
    redmine.open(id)
    return null
  },
  'redmine:set-key': ({ url, key }) => redmine.setKey(url, key),
  'redmine:clear': async () => {
    await redmine.clear()
    return null
  },
})

/**
 * Issues, writes, the summary, the view signal and the browser opener live in the notch; the server
 * and key are managed from the Control Center only. Both read the state.
 */
export const redmineChannelGuards = ({ fromNotch, fromControlCenter }: { fromNotch: Guard; fromControlCenter: Guard }): Record<RedmineChannel, Guard> => {
  const either: Guard = (event) => fromNotch(event) || fromControlCenter(event)
  return {
    'redmine:get-state': either,
    'redmine:issues': fromNotch,
    'redmine:issue': fromNotch,
    'redmine:activities': fromNotch,
    'redmine:update-issue': fromNotch,
    'redmine:log-time': fromNotch,
    'redmine:summary': fromNotch,
    'redmine:view': fromNotch,
    'redmine:refresh': fromNotch,
    'redmine:open': fromNotch,
    'redmine:set-key': fromControlCenter,
    'redmine:clear': fromControlCenter,
  }
}
