import { describe, expect, it } from 'vitest'
import { appIds, tiles, viewIntegrationIds } from '../../../src/shared/integrations/registry'

describe('integrations registry', () => {
  it('lists the nine tiles in panel order (Redmine after GitLab)', () => {
    expect(tiles).toHaveLength(9)
    expect(tiles.map((tile) => tile.id)).toEqual(['terminal', 'reminders', 'system', 'notes', 'gmail', 'github', 'gitlab', 'redmine', 'claude'])
  })

  it('makes only Terminal and Claude apps; the rest are views', () => {
    const apps = tiles.filter((tile) => tile.kind === 'app').map((tile) => tile.id)
    expect(apps).toEqual(['terminal', 'claude'])
    expect([...appIds].sort()).toEqual([...apps].sort())
    const views = tiles.filter((tile) => tile.kind === 'view').map((tile) => tile.id)
    expect(views).toEqual(['reminders', 'system', 'notes', 'gmail', 'redmine'])
    expect([...viewIntegrationIds].sort()).toEqual([...views, 'reviews'].sort())
  })

  it('makes GitHub and GitLab review tiles that open the reviews view on their platform', () => {
    const reviews = tiles.filter((tile) => tile.kind === 'review')
    expect(reviews.map((tile) => tile.id)).toEqual(['github', 'gitlab'])
    expect(reviews.map((tile) => tile.labelKey)).toEqual(['integration.github', 'integration.gitlab'])
  })

  it('makes Redmine a view tile that opens its own view', () => {
    expect(tiles.find((tile) => tile.id === 'redmine')).toEqual({ kind: 'view', id: 'redmine', labelKey: 'integration.redmine' })
  })
})
