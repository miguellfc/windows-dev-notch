import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkLogEntryView, WorkLogSnapshot } from '../../../src/shared/work-log/schema'

type Listener = (payload: unknown) => void

// The store needs the DOM's `window`, which the tests' tsconfig does not have: it is loaded by a
// path the compiler does not follow, and described here by what these tests use.
interface WorkLogStore {
  useWorkLogStore: { getState: () => WorkLogSnapshot }
  bindWorkLog: () => void
  liveTotalMs: (entry: WorkLogEntryView, now: number, idlePauseMs: number) => number
}
const STORE: string = '../../../src/renderer/shared/work-log-store'
const importStore = () => import(/* @vite-ignore */ STORE) as Promise<WorkLogStore>

const M = 60_000

function entry(overrides: Partial<WorkLogEntryView> = {}): WorkLogEntryView {
  return {
    sessionId: 's1',
    accountId: 'claude-work',
    project: 'ms-pay',
    status: 'running',
    invoiced: false,
    startedAt: 0,
    endedAt: null,
    claudeMs: 10 * M,
    totalMs: 10 * M,
    live: { lastEventAt: 10 * M, excessMs: 0, turnOpen: false, waitSince: null },
    title: 'Sesión',
    subtasks: [],
    ...overrides,
  }
}

function fakeNotch(list: WorkLogSnapshot) {
  const listeners = new Map<string, Listener[]>()
  const notch = {
    events: {
      on: (channel: string, listener: Listener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
        return () => undefined
      },
    },
    workLog: { list: vi.fn(async () => ({ ok: true, data: list })) },
  }
  vi.stubGlobal('window', { notch })
  const fire = (channel: string, payload: unknown) => (listeners.get(channel) ?? []).forEach((listener) => listener(payload))
  return { fire }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.resetModules()
})

describe('liveTotalMs', () => {
  it('adds the idle time since the last event, capped at the pause (Task 4 values)', async () => {
    const { liveTotalMs } = await importStore()
    expect(liveTotalMs(entry(), 55 * M, 30 * M)).toBe(40 * M)
  })

  it('counts all the time while a turn is open', async () => {
    const { liveTotalMs } = await importStore()
    expect(liveTotalMs(entry({ live: { lastEventAt: 10 * M, excessMs: 0, turnOpen: true, waitSince: null } }), 55 * M, 30 * M)).toBe(55 * M)
  })

  it('is the stored total for an ended entry and never goes back with an early clock', async () => {
    const { liveTotalMs } = await importStore()
    expect(liveTotalMs(entry({ status: 'ready', live: null, endedAt: 10 * M }), 99 * M, 30 * M)).toBe(10 * M)
    expect(liveTotalMs(entry(), 5 * M, 30 * M)).toBe(10 * M)
  })
})

describe('liveTotalMs: paused entries and waits', () => {
  it('keeps the stored total of a paused entry (no live growth)', async () => {
    const { liveTotalMs } = await importStore()
    expect(liveTotalMs(entry({ status: 'paused' }), 55 * M, 30 * M)).toBe(10 * M)
  })

  it('caps a pending wait for the user like an idle pause (main rules: 5 min work, wait from 5 min)', async () => {
    const { liveTotalMs } = await importStore()
    const waiting = entry({ totalMs: 5 * M, live: { lastEventAt: 5 * M, excessMs: 0, turnOpen: true, waitSince: 5 * M } })
    expect(liveTotalMs(waiting, 20 * M, 30 * M)).toBe(20 * M)
    expect(liveTotalMs(waiting, 125 * M, 30 * M)).toBe(35 * M)
  })
})

describe('bindWorkLog', () => {
  it('takes the listed snapshot, then every pushed one; a push wins over a late list', async () => {
    const listed: WorkLogSnapshot = { entries: [entry()], idlePauseMs: 30 * M }
    const { fire } = fakeNotch(listed)
    const { bindWorkLog, useWorkLogStore } = await importStore()
    expect(useWorkLogStore.getState().entries).toEqual([])
    bindWorkLog()
    await flush()
    expect(useWorkLogStore.getState()).toEqual(listed)
    const pushed: WorkLogSnapshot = { entries: [], idlePauseMs: 45 * M }
    fire('work-log:changed', pushed)
    expect(useWorkLogStore.getState()).toEqual(pushed)
  })

  it('ignores the list answer when a push already arrived', async () => {
    const { fire } = fakeNotch({ entries: [entry()], idlePauseMs: 30 * M })
    const { bindWorkLog, useWorkLogStore } = await importStore()
    bindWorkLog()
    fire('work-log:changed', { entries: [], idlePauseMs: 30 * M })
    await flush()
    expect(useWorkLogStore.getState().entries).toEqual([])
  })
})
