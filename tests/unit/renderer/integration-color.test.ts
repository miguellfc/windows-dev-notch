import { describe, expect, it } from 'vitest'
import { integrationStyle } from '../../../src/renderer/shared/integration-style'
import { nextSwatch } from '../../../src/renderer/ui/swatch-nav'

describe('integrationStyle', () => {
  it('apunta --int al token de la paleta', () => {
    expect(integrationStyle('blue')).toEqual({ '--int': 'var(--color-int-blue)' })
  })
})

describe('nextSwatch (rejilla de 3 x 7)', () => {
  it('derecha e izquierda dan la vuelta en los extremos', () => {
    expect(nextSwatch(20, 'ArrowRight')).toBe(0)
    expect(nextSwatch(0, 'ArrowLeft')).toBe(20)
    expect(nextSwatch(3, 'ArrowRight')).toBe(4)
    expect(nextSwatch(3, 'ArrowLeft')).toBe(2)
  })

  it('abajo y arriba saltan una fila de 7', () => {
    expect(nextSwatch(2, 'ArrowDown')).toBe(9)
    expect(nextSwatch(9, 'ArrowUp')).toBe(2)
  })

  it('abajo desde la última fila y arriba desde la primera se quedan donde están', () => {
    expect(nextSwatch(14, 'ArrowDown')).toBe(14)
    expect(nextSwatch(20, 'ArrowDown')).toBe(20)
    expect(nextSwatch(0, 'ArrowUp')).toBe(0)
    expect(nextSwatch(6, 'ArrowUp')).toBe(6)
  })

  it('Home y End van a los extremos; otras teclas no navegan', () => {
    expect(nextSwatch(8, 'Home')).toBe(0)
    expect(nextSwatch(8, 'End')).toBe(20)
    expect(nextSwatch(8, 'a')).toBeNull()
  })
})
