import type { ChannelName } from '../../shared/ipc/channels'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { CodeReviewIntegration } from './code-review-integration'

type CodeReviewChannel = Extract<ChannelName, `code-review:${string}`>
type Guard = (event: IpcEventLike) => boolean

/** Every handler waits for the stored tokens to load, so the first state is never a guess. */
export const createCodeReviewIpcHandlers = (
  codeReview: Pick<CodeReviewIntegration, 'ready' | 'state' | 'list' | 'refresh' | 'open' | 'setToken' | 'clear'>,
): Pick<IpcHandlers, CodeReviewChannel> => ({
  'code-review:get-state': async () => {
    await codeReview.ready
    return codeReview.state()
  },
  'code-review:list': ({ platform }) => codeReview.list(platform),
  'code-review:refresh': async () => {
    await codeReview.ready
    codeReview.refresh()
    return null
  },
  'code-review:open': async ({ platform, id }) => {
    await codeReview.ready
    codeReview.open(platform, id)
    return null
  },
  'code-review:set-token': ({ platform, token, url }) => codeReview.setToken(platform, token, url),
  'code-review:clear': async ({ platform }) => {
    await codeReview.clear(platform)
    return null
  },
})

/**
 * PR/MR lists and the browser opener live in the notch; tokens are managed from the Control Center
 * only. Both read the state.
 */
export const codeReviewChannelGuards = ({
  fromNotch,
  fromControlCenter,
}: {
  fromNotch: Guard
  fromControlCenter: Guard
}): Record<CodeReviewChannel, Guard> => {
  const either: Guard = (event) => fromNotch(event) || fromControlCenter(event)
  return {
    'code-review:get-state': either,
    'code-review:list': fromNotch,
    'code-review:refresh': fromNotch,
    'code-review:open': fromNotch,
    'code-review:set-token': fromControlCenter,
    'code-review:clear': fromControlCenter,
  }
}
