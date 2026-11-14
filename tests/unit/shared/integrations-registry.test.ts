import { describe, expect, it } from 'vitest'
import { appIds, tiles, viewIntegrationIds } from '../../../src/shared/integrations/registry'

describe('integrations registry', () => {
  it('lists the tiles in panel order', () => {
    expect(tiles.map((tile) => tile.id)).toEqual(['terminal', 'reminders', 'system', 'notes', 'gmail', 'github', 'gitlab', 'claude'])
  })

  it('makes only Terminal and Claude apps; the rest are views', () => {
    const apps = tiles.filter((tile) => tile.kind === 'app').map((tile) => tile.id)
    expect(apps).toEqual(['terminal', 'claude'])
    expect([...appIds].sort()).toEqual([...apps].sort())
    const views = tiles.filter((tile) => tile.kind === 'view').map((tile) => tile.id)
    expect(views).toEqual(['reminders', 'system', 'notes', 'gmail'])
    expect([...viewIntegrationIds]).toEqual([...views, 'reviews'])
  })

  it('makes GitHub and GitLab review tiles that open the reviews view on their platform', () => {
    const reviews = tiles.filter((tile) => tile.kind === 'review')
    expect(reviews.map((tile) => tile.id)).toEqual(['github', 'gitlab'])
    expect(reviews.map((tile) => tile.labelKey)).toEqual(['integration.github', 'integration.gitlab'])
  })
})
