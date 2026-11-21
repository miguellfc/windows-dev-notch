import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INTEGRATION_COLOR_HEX, integrationColorIds } from '../../../src/shared/integrations/colors'

const css = readFileSync('src/renderer/styles/global.css', 'utf8')

type Rgba = { r: number; g: number; b: number; a: number }

function token(name: string): string {
  // String.raw: in a plain template literal `\s` is just "s", and the regex would not skip spaces.
  const match = new RegExp(String.raw`--color-${name}:\s*([^;]+);`).exec(css)
  if (!match) throw new Error(`token --color-${name} not found`)
  return (match[1] ?? '').trim()
}

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1] ?? '0', 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!rgba) throw new Error(`unsupported colour: ${value}`)
  const [r, g, b, a = 1] = (rgba[1] ?? '').split(',').map((p) => Number(p.trim()))
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a }
}

const color = (name: string): Rgba => parse(token(name))

function compose(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a))
  return {
    r: mix(top.r, bottom.r),
    g: mix(top.g, bottom.g),
    b: mix(top.b, bottom.b),
    a: 1,
  }
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/* Mockup values are bluer than a pure alpha composite over #050506 (blue channel up to 3 off). */
function near(actual: Rgba, hex: string): void {
  const expected = parse(hex)
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(3)
}

function oklab({ r, g, b }: Rgba): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabDistance(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

const white: Rgba = { r: 255, g: 255, b: 255, a: 1 }

describe('design tokens (fusión 0.3.0)', () => {
  it('el texto secundario cumple 4,5:1 sobre tarjeta y sobre Void', () => {
    const void_ = color('obsidian-dense')
    expect(contrast(color('graphite'), compose(color('veil'), void_))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('graphite'), void_)).toBeGreaterThanOrEqual(4.5)
  })

  it('Grafito Cristal cumple 4,5:1 sobre la cápsula translúcida encima de blanco', () => {
    expect(contrast(color('graphite-glass'), compose(color('obsidian'), white))).toBeGreaterThanOrEqual(4.5)
  })

  it('coral y rojo se leen sobre Void, y el texto sobre coral y sobre selección también', () => {
    const void_ = color('obsidian-dense')
    expect(contrast(color('wait'), void_)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('fail'), void_)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('on-wait'), color('wait'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('on-select'), color('select'))).toBeGreaterThanOrEqual(4.5)
  })

  it('las superficies dan los valores de la maqueta y el hover anidado se distingue', () => {
    const void_ = color('obsidian-dense')
    const card = compose(color('veil'), void_)
    near(card, '#131315')
    near(compose(color('veil-tile'), void_), '#1a1a1d')
    near(compose(color('veil-hover'), void_), '#1f1f23')
    expect(luminance(compose(color('veil-tile'), card))).toBeGreaterThan(luminance(card))
  })

  it('Grafito cumple 4,5:1 en una fila en hover dentro de una tarjeta, y el rojo sobre tarjeta', () => {
    const card = compose(color('veil'), color('obsidian-dense'))
    expect(contrast(color('graphite'), compose(color('veil-tile'), card))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('fail'), card)).toBeGreaterThanOrEqual(4.5)
  })

  it('el nivel 0 de contribuciones es Grafito al 14 %', () => {
    const graphite = color('graphite')
    const level0 = color('contrib-0')
    expect({ r: level0.r, g: level0.g, b: level0.b }).toEqual({ r: graphite.r, g: graphite.g, b: graphite.b })
    expect(level0.a).toBe(0.14)
  })

  it('ya no existen los tokens ice ni abyss', () => {
    expect(css).not.toContain('--color-ice')
    expect(css).not.toContain('--color-abyss')
  })

  describe('paleta de integraciones (21 colores)', () => {
    const card = () => compose(color('veil'), color('obsidian-dense'))

    it.each(integrationColorIds)('--color-int-%s existe y coincide con la paleta', (id) => {
      expect(token(`int-${id}`).toLowerCase()).toBe(INTEGRATION_COLOR_HEX[id].toLowerCase())
    })

    it('el color por defecto es el verde', () => {
      expect(token('int-default')).toBe('var(--color-int-green)')
    })

    it.each(integrationColorIds)('%s da al menos 3:1 sobre la tarjeta', (id) => {
      expect(contrast(color(`int-${id}`), card())).toBeGreaterThanOrEqual(3)
    })

    it.each(integrationColorIds)('%s está a OKLab >= 0,07 del coral y del rojo', (id) => {
      expect(oklabDistance(color(`int-${id}`), color('wait'))).toBeGreaterThanOrEqual(0.07)
      expect(oklabDistance(color(`int-${id}`), color('fail'))).toBeGreaterThanOrEqual(0.07)
    })
  })
})
