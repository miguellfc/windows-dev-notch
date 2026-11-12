import type { ChannelName } from '../../shared/ipc/channels'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { GmailIntegration } from './gmail-integration'

type GmailChannel = Extract<ChannelName, `gmail:${string}`>
type Guard = (event: IpcEventLike) => boolean

/** Every handler waits for the stored token to load, so the first state is never a guess. */
export const createGmailIpcHandlers = (
  gmail: Pick<GmailIntegration, 'ready' | 'state' | 'recent' | 'setViewOpen' | 'refresh' | 'open' | 'signIn' | 'cancelSignIn' | 'signOut'>,
  pickClientFile: () => Promise<{ clientId: string; clientSecret: string } | null>,
): Pick<IpcHandlers, GmailChannel> => ({
  'gmail:get-state': async () => {
    await gmail.ready
    return gmail.state()
  },
  'gmail:recent': () => gmail.recent(),
  'gmail:view': async ({ open }) => {
    await gmail.ready
    gmail.setViewOpen(open)
    return null
  },
  'gmail:refresh': async () => {
    await gmail.ready
    gmail.refresh()
    return null
  },
  'gmail:open': async ({ id }) => {
    await gmail.ready
    gmail.open(id)
    return null
  },
  'gmail:sign-in': () => gmail.signIn(),
  'gmail:cancel-sign-in': () => {
    gmail.cancelSignIn()
    return null
  },
  'gmail:sign-out': async () => {
    await gmail.signOut()
    return null
  },
  'gmail:pick-client-file': () => pickClientFile(),
})

/**
 * Mail data and the browser opener live in the notch; the session (sign-in, sign-out) is managed
 * from the Control Center only. Both read the state.
 */
export const gmailChannelGuards = ({ fromNotch, fromControlCenter }: { fromNotch: Guard; fromControlCenter: Guard }): Record<GmailChannel, Guard> => {
  const either: Guard = (event) => fromNotch(event) || fromControlCenter(event)
  return {
    'gmail:get-state': either,
    'gmail:recent': fromNotch,
    'gmail:view': fromNotch,
    'gmail:refresh': fromNotch,
    'gmail:open': fromNotch,
    'gmail:sign-in': fromControlCenter,
    'gmail:cancel-sign-in': fromControlCenter,
    'gmail:sign-out': fromControlCenter,
    'gmail:pick-client-file': fromControlCenter,
  }
}
