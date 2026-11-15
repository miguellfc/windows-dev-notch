import type { appIds } from '../../shared/integrations/registry'
import type { IpcEventLike } from '../ipc/register'
import type { AppId } from './app-launcher'

type Guard = (event: IpcEventLike) => boolean

// The registry's `appIds` and the launcher's `AppId` must stay the same set (checked at compile time).
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _appIdsAgree: SameSet<(typeof appIds)[number], AppId> = true
void _appIdsAgree

/** Launching an app is a notch tile action: no other window may open Claude or a terminal. */
export const appsChannelGuards = ({ fromNotch }: { fromNotch: Guard }): { 'apps:open': Guard } => ({
  'apps:open': fromNotch,
})
