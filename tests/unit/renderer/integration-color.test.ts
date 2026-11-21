import { describe, expect, it } from 'vitest'
import { integrationStyle } from '../../../src/renderer/shared/integration-style'

describe('integrationStyle', () => {
  it('apunta --int al token de la paleta', () => {
    expect(integrationStyle('blue')).toEqual({ '--int': 'var(--color-int-blue)' })
  })

  it('un color propio pone el hex tal cual', () => {
    expect(integrationStyle('#A3B18A')).toEqual({ '--int': '#A3B18A' })
  })
})
