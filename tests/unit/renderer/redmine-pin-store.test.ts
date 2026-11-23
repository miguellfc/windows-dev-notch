import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (payload: unknown) => void

interface Issue {
  id: number
  subject: string
}
interface PinStore {
  useRedmine: { getState: () => { pinned: Issue | null; openTarget: number | null } }
  bindRedmine: () => void
  togglePinnedIssue: (issue: Issue) => void
  unpinIssue: (id: number) => void
  renamePinnedIssue: (id: number, subject: string) => void
  openPinnedIssue: () => void
  takeOpenTarget: () => number | null
}
// The store needs the DOM's `window`, which the tests' tsconfig does not have: it is loaded by a
// path the compiler does not follow, and described here by what these tests use.
const STORE: string = '../../../src/renderer/shared/redmine-store'
const importStore = () => import(/* @vite-ignore */ STORE) as Promise<PinStore>

const A: Issue = { id: 1, subject: 'Alpha' }
const B: Issue = { id: 2, subject: 'Beta' }

function fakeNotch() {
  const listeners = new Map<string, Listener[]>()
  const openIntegration = vi.fn(async () => ({ ok: true, data: null }))
  const notch = {
    events: {
      on: (channel: string, listener: Listener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
        return () => undefined
      },
    },
    notch: { openIntegration },
    redmine: {
      getState: vi.fn(async () => ({ ok: false })),
      summary: vi.fn(async () => ({ ok: false })),
    },
  }
  vi.stubGlobal('window', { notch })
  const fire = (channel: string, payload: unknown) => (listeners.get(channel) ?? []).forEach((listener) => listener(payload))
  return { fire, openIntegration }
}

beforeEach(() => {
  vi.resetModules()
})

describe('pin actions', () => {
  it('toggles: a second issue replaces the first, the same one unpins', async () => {
    fakeNotch()
    const store = await importStore()
    store.togglePinnedIssue(A)
    expect(store.useRedmine.getState().pinned).toEqual(A)
    store.togglePinnedIssue(B)
    expect(store.useRedmine.getState().pinned).toEqual(B)
    store.togglePinnedIssue(B)
    expect(store.useRedmine.getState().pinned).toBeNull()
  })

  it('unpinIssue only releases the pinned issue', async () => {
    fakeNotch()
    const store = await importStore()
    store.togglePinnedIssue(A)
    store.unpinIssue(B.id)
    expect(store.useRedmine.getState().pinned).toEqual(A)
    store.unpinIssue(A.id)
    expect(store.useRedmine.getState().pinned).toBeNull()
  })

  it('renamePinnedIssue refreshes the subject of the pinned issue only', async () => {
    fakeNotch()
    const store = await importStore()
    store.togglePinnedIssue(A)
    store.renamePinnedIssue(B.id, 'Other')
    expect(store.useRedmine.getState().pinned).toEqual(A)
    store.renamePinnedIssue(A.id, 'Renamed')
    expect(store.useRedmine.getState().pinned).toEqual({ id: A.id, subject: 'Renamed' })
  })
})

describe('openPinnedIssue', () => {
  it('does nothing without a pinned issue', async () => {
    const { openIntegration } = fakeNotch()
    const store = await importStore()
    store.openPinnedIssue()
    expect(openIntegration).not.toHaveBeenCalled()
    expect(store.useRedmine.getState().openTarget).toBeNull()
  })

  it('sets the target and asks main to open Redmine once', async () => {
    const { openIntegration } = fakeNotch()
    const store = await importStore()
    store.togglePinnedIssue(A)
    store.openPinnedIssue()
    expect(store.useRedmine.getState().openTarget).toBe(A.id)
    expect(openIntegration).toHaveBeenCalledTimes(1)
    expect(openIntegration).toHaveBeenCalledWith({ id: 'redmine' })
  })

  it('takeOpenTarget returns the target once, then null', async () => {
    fakeNotch()
    const store = await importStore()
    store.togglePinnedIssue(A)
    store.openPinnedIssue()
    expect(store.takeOpenTarget()).toBe(A.id)
    expect(store.takeOpenTarget()).toBeNull()
  })
})

describe('session end', () => {
  it('an unconfigured redmine:state clears the pin and the target (through bindRedmine)', async () => {
    const { fire } = fakeNotch()
    const store = await importStore()
    store.bindRedmine()
    store.togglePinnedIssue(A)
    store.openPinnedIssue()
    fire('redmine:state', { status: 'unconfigured', account: null, hours: null })
    expect(store.useRedmine.getState().pinned).toBeNull()
    expect(store.useRedmine.getState().openTarget).toBeNull()
  })
})
