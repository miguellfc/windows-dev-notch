import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (payload: unknown) => void

// The stores need the DOM's `window`, which the tests' tsconfig does not have: they are loaded by a
// path the compiler does not follow, and described here by what these tests use.
interface GmailStore {
  useGmail: { getState: () => { recent: unknown } }
  loadRecent: () => Promise<void>
  bindGmail: () => void
  bindGmailPanel: () => void
}
interface CodeReviewStore {
  useCodeReview: { getState: () => { contributions: Record<string, unknown>; blocks: Record<'github' | 'gitlab', { total: number | null }> } }
  bindCodeReview: () => void
  bindCodeReviewContributions: () => void
}
const GMAIL_STORE: string = '../../../src/renderer/shared/gmail-store'
const CODE_REVIEW_STORE: string = '../../../src/renderer/shared/code-review-store'
const importGmail = () => import(/* @vite-ignore */ GMAIL_STORE) as Promise<GmailStore>
const importCodeReview = () => import(/* @vite-ignore */ CODE_REVIEW_STORE) as Promise<CodeReviewStore>

/** A fake `window.notch`: events the test fires by hand and the IPC answers the stores read. */
function fakeNotch(mode = 'peek') {
  const listeners = new Map<string, Listener[]>()
  const recent = vi.fn(async () => ({ ok: true, data: [{ id: 'm1' }] }))
  const contributions = vi.fn(async ({ platform }: { platform: string }) => ({ ok: true, data: { summary: null as unknown, error: false, platform } }))
  const notch = {
    events: {
      on: (channel: string, listener: Listener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
        return () => undefined
      },
    },
    gmail: { getState: async () => ({ ok: false }), recent },
    codeReview: { getState: async () => ({ ok: false }), contributions },
    notch: { getMode: async () => ({ ok: true, data: mode }) },
  }
  vi.stubGlobal('window', { notch })
  const fire = (channel: string, payload: unknown) => (listeners.get(channel) ?? []).forEach((listener) => listener(payload))
  return { fire, recent, contributions }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const gmailState = (status: string, updatedAt = '2026-11-18T10:00:00.000Z') => ({ status, account: 'a', unread: 1, updatedAt, persistent: true })

beforeEach(() => {
  vi.resetModules()
})

describe('gmail store: the recent list for the panel', () => {
  it('starts empty and loadRecent keeps the answer', async () => {
    const { recent } = fakeNotch()
    const { useGmail, loadRecent } = await importGmail()
    expect(useGmail.getState().recent).toBeNull()
    await loadRecent()
    expect(recent).toHaveBeenCalledTimes(1)
    expect(useGmail.getState().recent).toEqual([{ id: 'm1' }])
  })

  it('loads when the panel opens and again on each Gmail state while it stays open', async () => {
    const { fire, recent } = fakeNotch()
    const { bindGmail, bindGmailPanel } = await importGmail()
    bindGmail()
    bindGmailPanel()
    await flush()
    fire('gmail:state', gmailState('ok'))
    await flush()
    expect(recent).not.toHaveBeenCalled()

    fire('notch:mode-changed', 'expanded')
    await flush()
    expect(recent).toHaveBeenCalledTimes(1)
    fire('gmail:state', gmailState('ok', '2026-11-18T10:01:00.000Z'))
    await flush()
    expect(recent).toHaveBeenCalledTimes(2)

    // Inside the Gmail view its own list rules: main's shown ids must not move under it.
    fire('notch:mode-changed', 'gmail')
    fire('gmail:state', gmailState('ok', '2026-11-18T10:02:00.000Z'))
    await flush()
    expect(recent).toHaveBeenCalledTimes(2)
  })

  it('reads the list when the notch was already on the panel at bind time', async () => {
    const { fire, recent } = fakeNotch('expanded')
    const { bindGmail, bindGmailPanel } = await importGmail()
    bindGmail()
    bindGmailPanel()
    await flush()
    fire('gmail:state', gmailState('ok'))
    await flush()
    expect(recent).toHaveBeenCalled()
  })

  it('a window without the panel binding (Control Center) never asks for the list', async () => {
    const { fire, recent } = fakeNotch()
    const { bindGmail } = await importGmail()
    bindGmail()
    fire('notch:mode-changed', 'expanded')
    fire('gmail:state', gmailState('ok'))
    await flush()
    expect(recent).not.toHaveBeenCalled()
  })

  it('forgets the mail of a session that ended, also when its answer arrives late', async () => {
    const { fire, recent } = fakeNotch()
    const { bindGmail, loadRecent, useGmail } = await importGmail()
    bindGmail()
    await loadRecent()
    expect(useGmail.getState().recent).not.toBeNull()

    let answer: (value: { ok: true; data: { id: string }[] }) => void = () => undefined
    recent.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never)
    const late = loadRecent()
    fire('gmail:state', gmailState('signed-out'))
    expect(useGmail.getState().recent).toBeNull()
    answer({ ok: true, data: [{ id: 'old' }] })
    await late
    expect(useGmail.getState().recent).toBeNull()
  })

  it('keeps the last list when a read fails', async () => {
    const { recent } = fakeNotch()
    const { loadRecent, useGmail } = await importGmail()
    await loadRecent()
    recent.mockResolvedValueOnce({ ok: false } as never)
    await loadRecent()
    expect(useGmail.getState().recent).toEqual([{ id: 'm1' }])
  })
})

describe('code review store: contributions with the view closed', () => {
  it('fills the platform named by code-review:contributions-changed', async () => {
    const { fire, contributions } = fakeNotch()
    const { bindCodeReview, useCodeReview } = await importCodeReview()
    bindCodeReview()
    fire('code-review:contributions-changed', { platform: 'gitlab', error: false })
    await flush()
    expect(contributions).toHaveBeenCalledWith({ platform: 'gitlab' })
    expect(useCodeReview.getState().contributions.gitlab).toBeDefined()
    expect(useCodeReview.getState().contributions.github).toBeUndefined()
  })
  it('asks once for the contributions of a platform that turns live, and latches its month total for the capsule', async () => {
    const { fire, contributions } = fakeNotch()
    const summary = { month: '2026-11', monthTotal: 143 }
    contributions.mockImplementation(async ({ platform }) => ({ ok: true, data: { summary: platform === 'github' ? summary : null, error: false, platform } }))
    const { bindCodeReview, bindCodeReviewContributions, useCodeReview } = await importCodeReview()
    bindCodeReview()
    bindCodeReviewContributions()
    const reading = (github: string, gitlab: string) => ({ github: gmailState(github), gitlab: gmailState(gitlab) })
    fire('code-review:state', reading('ok', 'unconfigured'))
    await flush()
    expect(contributions).toHaveBeenCalledTimes(1)
    expect(contributions).toHaveBeenCalledWith({ platform: 'github' })
    expect(useCodeReview.getState().blocks.github.total).toBe(143)
    expect(useCodeReview.getState().blocks.gitlab.total).toBeNull()
    // Later readings leave it to main's contributions-changed events.
    fire('code-review:state', reading('ok', 'unconfigured'))
    await flush()
    expect(contributions).toHaveBeenCalledTimes(1)
    fire('code-review:state', reading('auth-error', 'unconfigured'))
    expect(useCodeReview.getState().blocks.github.total).toBeNull()
  })

  it('the Control Center (no bindCodeReviewContributions) never asks: the channel belongs to the notch', async () => {
    const { fire, contributions } = fakeNotch()
    const { bindCodeReview } = await importCodeReview()
    bindCodeReview()
    fire('code-review:state', { github: gmailState('ok'), gitlab: gmailState('ok') })
    await flush()
    expect(contributions).not.toHaveBeenCalled()
  })
})
