import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CARD_RGB,
  OBSIDIAN_DENSE,
  VEIL_ALPHA,
  cardContrast,
  checkColor,
  colorToStore,
  formatRatio,
  hexToHsl,
  hslToHex,
  normalizeHex,
} from '../../../src/renderer/ui/color-picker-math'
import { INTEGRATION_COLOR_HEX, integrationColorIds } from '../../../src/shared/integrations/colors'

describe('normalizeHex', () => {
  it('acepta 6 cifras con o sin #, en cualquier caja, y las pasa a mayúsculas', () => {
    expect(normalizeHex('#a3b18a')).toBe('#A3B18A')
    expect(normalizeHex('A3B18A')).toBe('#A3B18A')
    expect(normalizeHex('  #4ade80 ')).toBe('#4ADE80')
  })

  it('rechaza lo demás', () => {
    for (const text of ['', '#', '#12345', '#1234567', 'GGGGGG', '#4ade8', 'red', '##4ADE80']) expect(normalizeHex(text), text).toBeNull()
  })
})

describe('HSL ↔ hex', () => {
  it('convierte los casos conocidos', () => {
    expect(hslToHex({ h: 0, s: 100, l: 50 })).toBe('#FF0000')
    expect(hslToHex({ h: 120, s: 100, l: 50 })).toBe('#00FF00')
    expect(hslToHex({ h: 240, s: 100, l: 50 })).toBe('#0000FF')
    expect(hslToHex({ h: 360, s: 100, l: 50 })).toBe('#FF0000')
    expect(hslToHex({ h: 200, s: 0, l: 100 })).toBe('#FFFFFF')
    expect(hslToHex({ h: 0, s: 0, l: 0 })).toBe('#000000')
    expect(hexToHsl('#FF0000')).toEqual({ h: 0, s: 100, l: 50 })
    expect(hexToHsl('#808080')).toEqual({ h: 0, s: 0, l: 50 })
    expect(hexToHsl('#4ADE80')).toEqual({ h: 142, s: 69, l: 58 })
  })

  it('ida y vuelta de toda la paleta queda a menos de 3 unidades por canal', () => {
    for (const id of integrationColorIds) {
      const hex = INTEGRATION_COLOR_HEX[id]
      const back = hslToHex(hexToHsl(hex))
      for (const i of [1, 3, 5]) {
        expect(Math.abs(Number.parseInt(back.slice(i, i + 2), 16) - Number.parseInt(hex.slice(i, i + 2), 16)), id).toBeLessThanOrEqual(3)
      }
    }
  })
})

describe('contraste y avisos', () => {
  it('la tarjeta es el Velo sobre Obsidiana Densa de global.css', () => {
    const css = readFileSync(resolve(__dirname, '../../../src/renderer/styles/global.css'), 'utf8')
    const flat = css.replace(/\s+/g, '')
    expect(flat.toLowerCase()).toContain(`--color-obsidian-dense:${OBSIDIAN_DENSE.toLowerCase()};`)
    expect(flat).toContain(`--color-veil:rgba(255,255,255,${VEIL_ALPHA});`)
    expect(CARD_RGB.map(Math.round)).toEqual([19, 19, 20])
  })

  it('calcula el contraste WCAG contra la tarjeta', () => {
    // Card ≈ #131314: luminance ≈ 0.0065, so white gives (1 + 0.05) / (0.0065 + 0.05) ≈ 18.6.
    expect(cardContrast('#FFFFFF')).toBeCloseTo(18.57, 1)
    expect(cardContrast('#131314')).toBeLessThan(1.1)
    for (const id of integrationColorIds) expect(cardContrast(INTEGRATION_COLOR_HEX[id]), id).toBeGreaterThanOrEqual(5)
  })

  it('un color de la paleta frío no da avisos', () => {
    expect(checkColor('#4ADE80')).toMatchObject({ lowContrast: false, nearAlert: false, nearGray: false })
  })

  it('avisa de poco contraste, de parecido al coral o al rojo y de casi gris', () => {
    expect(checkColor('#203040').lowContrast).toBe(true)
    expect(checkColor('#FF8A7A').nearAlert).toBe(true)
    expect(checkColor('#F06A6A').nearAlert).toBe(true)
    expect(checkColor('#A3B18A').nearAlert).toBe(false)
    expect(checkColor('#FF8C7C').nearAlert).toBe(true)
    // The palette was vetted against coral and red: none of its colours gets the note.
    for (const id of integrationColorIds) expect(checkColor(INTEGRATION_COLOR_HEX[id]).nearAlert, id).toBe(false)
    expect(checkColor('#8E8E96').nearGray).toBe(true)
    expect(checkColor('#A3B18A').nearGray).toBe(false)
  })

  it('formatea la razón con un decimal, coma en español, sin redondear hacia arriba', () => {
    expect(formatRatio(2.97, 'es')).toBe('2,9')
    expect(formatRatio(12.345, 'en')).toBe('12.3')
    expect(formatRatio(3, 'es')).toBe('3,0')
  })
})

describe('colorToStore', () => {
  it('guarda el id cuando el hex es de la paleta y el hex si no', () => {
    expect(colorToStore('#4ADE80')).toBe('green')
    expect(colorToStore('#4ade80')).toBe('green')
    expect(colorToStore('#A3B18A')).toBe('#A3B18A')
  })
})
