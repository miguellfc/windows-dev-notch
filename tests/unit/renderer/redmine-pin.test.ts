import { describe, expect, it } from 'vitest'
import { shortcutShown, togglePin, withSubject, type PinnedIssue } from '../../../src/renderer/shared/redmine/pin'
import { cloneDefaultIntegrations } from '../../../src/shared/settings/schema'

const A: PinnedIssue = { id: 1, subject: 'Alpha' }
const B: PinnedIssue = { id: 2, subject: 'Beta' }

describe('togglePin', () => {
  it('pins an issue when nothing is pinned', () => {
    expect(togglePin(null, A)).toBe(A)
  })

  it('unpins the pinned issue', () => {
    expect(togglePin(A, A)).toBeNull()
  })

  it('replaces the pinned issue when another one is pinned', () => {
    expect(togglePin(A, B)).toBe(B)
  })
})

describe('withSubject', () => {
  it('updates the subject of the pinned issue', () => {
    expect(withSubject(A, A.id, 'nuevo')).toEqual({ id: A.id, subject: 'nuevo' })
  })

  it('keeps the same object for another issue or an unchanged subject', () => {
    expect(withSubject(A, B.id, 'x')).toBe(A)
    expect(withSubject(A, A.id, A.subject)).toBe(A)
  })

  it('stays null when nothing is pinned', () => {
    expect(withSubject(null, 1, 'x')).toBeNull()
  })
})

describe('shortcutShown', () => {
  const integrations = cloneDefaultIntegrations()

  it('is shown while the session is ok or offline', () => {
    expect(shortcutShown(A, 'ok', integrations)).toBe(true)
    expect(shortcutShown(A, 'offline', integrations)).toBe(true)
  })

  it('is hidden without a live session', () => {
    for (const status of ['unconfigured', 'auth-error', undefined] as const) {
      expect(shortcutShown(A, status, integrations)).toBe(false)
    }
  })

  it('is hidden without a pinned issue', () => {
    expect(shortcutShown(null, 'ok', integrations)).toBe(false)
  })

  it('is hidden while the settings are unknown or Redmine is disabled', () => {
    expect(shortcutShown(A, 'ok', null)).toBe(false)
    expect(shortcutShown(A, 'ok', { ...integrations, redmine: { ...integrations.redmine, enabled: false } })).toBe(false)
  })

  it('is hidden on the pinned issue itself', () => {
    expect(shortcutShown(A, 'ok', integrations, A.id)).toBe(false)
    expect(shortcutShown(A, 'ok', integrations, B.id)).toBe(true)
  })
})
