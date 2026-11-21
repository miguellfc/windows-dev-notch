import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTEGRATION_COLORS,
  HEX_COLOR,
  INTEGRATION_COLOR_HEX,
  capsuleIntegrationKeys,
  colorHex,
  integrationColorIds,
  integrationKeys,
  paletteIdFor,
} from '../../../src/shared/integrations/colors'
import { messages, type MessageKey } from '../../../src/shared/i18n/messages'

describe('integration palette', () => {
  it('has 21 unique ids, each with a hex', () => {
    expect(integrationColorIds).toHaveLength(21)
    expect(new Set(integrationColorIds).size).toBe(21)
    for (const id of integrationColorIds) expect(INTEGRATION_COLOR_HEX[id]).toMatch(/^#[0-9A-F]{6}$/)
    expect(Object.keys(INTEGRATION_COLOR_HEX).sort()).toEqual([...integrationColorIds].sort())
  })

  it('keeps the agreed hex values', () => {
    expect(INTEGRATION_COLOR_HEX.salmon).toBe('#FDA4AF')
    expect(INTEGRATION_COLOR_HEX.clay).toBe('#CC785C')
    expect(INTEGRATION_COLOR_HEX.blue).toBe('#7DD3FC')
  })

  it('lists the integrations in order, capsule ones first', () => {
    expect(integrationKeys).toEqual(['claude', 'github', 'gitlab', 'gmail', 'redmine', 'reminders', 'notes'])
    expect(capsuleIntegrationKeys).toEqual(['claude', 'github', 'gitlab', 'gmail', 'redmine'])
  })

  it('has the default colors of the global constraints', () => {
    expect(DEFAULT_INTEGRATION_COLORS).toEqual({
      claude: 'clay',
      github: 'green',
      gitlab: 'orange',
      gmail: 'salmon',
      redmine: 'pink',
      reminders: 'blue',
      notes: 'violet',
    })
  })

  it('has a color name in ES and EN for every id', () => {
    for (const id of integrationColorIds) {
      const key = `color.${id}` as MessageKey
      expect(messages.es[key], key).toBeTruthy()
      expect(messages.en[key], key).toBeTruthy()
    }
    expect(messages.es['color.pistachio']).toBe('Pistacho')
    expect(messages.en['color.peach']).toBe('Peach')
  })

  it('accepts uppercase #RRGGBB as a custom color only', () => {
    expect(HEX_COLOR.test('#A3B18A')).toBe(true)
    for (const text of ['#a3b18a', '#12345', 'A3B18A', 'red', '']) expect(HEX_COLOR.test(text), text).toBe(false)
  })

  it('turns a color into its hex and a hex back into a palette id', () => {
    expect(colorHex('green')).toBe('#4ADE80')
    expect(colorHex('#A3B18A')).toBe('#A3B18A')
    expect(paletteIdFor('#4ADE80')).toBe('green')
    expect(paletteIdFor('#cc785c')).toBe('clay')
    expect(paletteIdFor('#A3B18A')).toBeNull()
  })
})
