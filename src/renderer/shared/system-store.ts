import { create } from 'zustand'
import type { ProcessRow, SystemMetrics } from '../../shared/system/schema'
import { EMPTY_CAPSULE, nextCapsule, type CapsuleLatch } from '../notch/system/capsule-latch'

interface SystemStoreState {
  /** Latest sample; null until the first one arrives. Kept while sampling pauses (mini, hidden). */
  metrics: SystemMetrics | null
  /** Latest top-process list; empty until the system view asks for it. */
  processes: ProcessRow[]
  /** What the compact capsule shows, latched so a single missing reading does not change its width. */
  capsule: CapsuleLatch
}

export const useSystem = create<SystemStoreState>(() => ({ metrics: null, processes: [], capsule: EMPTY_CAPSULE }))

/**
 * Keeps the store in sync with the main process. There is nothing to read first: main pushes a
 * sample as soon as a sampling rhythm starts, so the store fills on the first event.
 */
export function bindSystem(): void {
  window.notch.events.on('system:metrics', (metrics) =>
    useSystem.setState((state) => ({ metrics, capsule: nextCapsule(state.capsule, metrics) })),
  )
  window.notch.events.on('system:processes', (processes) => useSystem.setState({ processes }))
}
