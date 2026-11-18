import { describe, expect, it } from 'vitest'
import { appIds, reviewPlatformIds, viewIntegrationIds } from '../../../src/shared/integrations/registry'

describe('integrations registry', () => {
  it('lists the mini tools the notch opens', () => {
    expect(viewIntegrationIds).toEqual(['reminders', 'system', 'notes', 'gmail', 'reviews', 'redmine'])
  })

  it('makes only Terminal and Claude apps', () => {
    expect(appIds).toEqual(['terminal', 'claude'])
  })

  it('opens the reviews view on GitHub and GitLab', () => {
    expect(reviewPlatformIds).toEqual(['github', 'gitlab'])
  })
})
