import { describe, expect, it } from 'vitest'
import { acceleratorFromKey, formatAccelerator, type KeyInput } from '../../../src/shared/settings/accelerator'
import { settingsSchema, createDefaultSettings } from '../../../src/shared/settings/schema'

const key = (code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})

describe('acceleratorFromKey', () => {
  it('builds Electron accelerators with modifiers in a stable order', () => {
    expect(acceleratorFromKey(key('Space', { ctrlKey: true, altKey: true }))).toEqual({
      kind: 'ok',
      accelerator: 'Control+Alt+Space',
    })
    expect(acceleratorFromKey(key('KeyN', { altKey: true, shiftKey: true }))).toEqual({ kind: 'ok', accelerator: 'Alt+Shift+N' })
    expect(acceleratorFromKey(key('Digit1', { metaKey: true }))).toEqual({ kind: 'ok', accelerator: 'Super+1' })
    expect(acceleratorFromKey(key('F12', { ctrlKey: true }))).toEqual({ kind: 'ok', accelerator: 'Control+F12' })
    expect(acceleratorFromKey(key('ArrowUp', { ctrlKey: true }))).toEqual({ kind: 'ok', accelerator: 'Control+Up' })
    expect(acceleratorFromKey(key('Numpad5', { ctrlKey: true }))).toEqual({ kind: 'ok', accelerator: 'Control+num5' })
  })

  it('waits while only modifiers are pressed', () => {
    expect(acceleratorFromKey(key('ControlLeft', { ctrlKey: true }))).toEqual({ kind: 'incomplete' })
    expect(acceleratorFromKey(key('AltRight', { altKey: true }))).toEqual({ kind: 'incomplete' })
  })

  it('requires Ctrl, Alt or Win (Shift alone is not enough)', () => {
    expect(acceleratorFromKey(key('KeyA'))).toEqual({ kind: 'needs-modifier' })
    expect(acceleratorFromKey(key('KeyA', { shiftKey: true }))).toEqual({ kind: 'needs-modifier' })
  })

  it('rejects keys outside the supported set', () => {
    expect(acceleratorFromKey(key('Backquote', { ctrlKey: true }))).toEqual({ kind: 'unsupported' })
    expect(acceleratorFromKey(key('Escape', { ctrlKey: true }))).toEqual({ kind: 'unsupported' })
  })

  it('only produces shortcuts the settings schema accepts', () => {
    const base = createDefaultSettings('es')
    const result = acceleratorFromKey(key('PageDown', { ctrlKey: true, shiftKey: true }))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(settingsSchema.safeParse({ ...base, shortcut: result.accelerator }).success).toBe(true)
  })
})

describe('formatAccelerator', () => {
  it('renders the keys people read on their keyboard', () => {
    expect(formatAccelerator('Control+Alt+Space')).toEqual(['Ctrl', 'Alt', 'Space'])
    expect(formatAccelerator('Super+Shift+N')).toEqual(['Win', 'Shift', 'N'])
    expect(formatAccelerator('CommandOrControl+Up')).toEqual(['Ctrl', '↑'])
  })
})
