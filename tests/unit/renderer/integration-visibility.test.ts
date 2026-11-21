import { describe, expect, it } from 'vitest'
import { integrationKeys } from '../../../src/shared/integrations/colors'
import { cloneDefaultIntegrations, type IntegrationsSettings } from '../../../src/shared/settings/schema'
import { alertAllowed, capsuleShows, viewAllowed, visibleCards } from '../../../src/renderer/notch/integration-visibility'

const withOff = (...keys: (keyof IntegrationsSettings)[]): IntegrationsSettings => {
  const integrations = cloneDefaultIntegrations()
  for (const key of keys) integrations[key].enabled = false
  return integrations
}

describe('visibleCards', () => {
  it('shows seven cards, in the order of integrationKeys, when everything is on', () => {
    expect(visibleCards(cloneDefaultIntegrations())).toEqual(['claude', 'github', 'gitlab', 'gmail', 'redmine', 'reminders', 'notes'])
  })

  it('drops gmail when it is off', () => {
    const keys = visibleCards(withOff('gmail'))
    expect(keys).toHaveLength(6)
    expect(keys).not.toContain('gmail')
  })

  it('shows no card with every integration off', () => {
    expect(visibleCards(withOff(...integrationKeys))).toEqual([])
  })
})

describe('capsuleShows', () => {
  it('is false when the capsule is off, even with the integration on', () => {
    const integrations = cloneDefaultIntegrations()
    integrations.gmail.capsule = false
    expect(capsuleShows('gmail', integrations)).toBe(false)
  })

  it('is false when the integration is off, even with the capsule on', () => {
    expect(capsuleShows('redmine', withOff('redmine'))).toBe(false)
  })
})

describe('viewAllowed', () => {
  it('closes gmail when it is off', () => {
    expect(viewAllowed('gmail', withOff('gmail'))).toBe(false)
    expect(viewAllowed('gmail', cloneDefaultIntegrations())).toBe(true)
  })

  it('keeps reviews while one platform is on', () => {
    expect(viewAllowed('reviews', withOff('github'))).toBe(true)
    expect(viewAllowed('reviews', withOff('gitlab'))).toBe(true)
    expect(viewAllowed('reviews', withOff('github', 'gitlab'))).toBe(false)
  })

  it('always allows home, and ties the Claude items to claude', () => {
    expect(viewAllowed('home', withOff('claude', 'notes'))).toBe(true)
    expect(viewAllowed('permission', withOff('claude'))).toBe(false)
    expect(viewAllowed('question', cloneDefaultIntegrations())).toBe(true)
  })
})

describe('alertAllowed', () => {
  it('follows gitlab.enabled for a GitLab review alert', () => {
    expect(alertAllowed('review-gitlab', withOff('gitlab'))).toBe(false)
    expect(alertAllowed('review-gitlab', withOff('github'))).toBe(true)
  })

  it('follows each integration for the other alerts', () => {
    expect(alertAllowed('mail', withOff('gmail'))).toBe(false)
    expect(alertAllowed('redmine', withOff('redmine'))).toBe(false)
    expect(alertAllowed('reminder', withOff('reminders'))).toBe(false)
    expect(alertAllowed('claude', withOff('claude'))).toBe(false)
    expect(alertAllowed('mail', cloneDefaultIntegrations())).toBe(true)
  })
})
