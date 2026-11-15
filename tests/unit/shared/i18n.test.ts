import { describe, expect, it } from 'vitest'
import { messages, translate } from '../../../src/shared/i18n/messages'

describe('messages', () => {
  it('defines exactly the same keys in Spanish and English', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.es).sort())
  })

  it('has no empty strings', () => {
    for (const [language, dictionary] of Object.entries(messages)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), `${language}.${key}`).not.toBe('')
      }
    }
  })

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(messages.es) as (keyof typeof messages.es)[]) {
      expect(placeholders(messages.en[key]), key).toEqual(placeholders(messages.es[key]))
    }
  })
})

describe('translate', () => {
  it('returns the message for the language', () => {
    expect(translate('es', 'tray.quit')).toBe('Salir')
    expect(translate('en', 'tray.quit')).toBe('Quit')
  })

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'notch.peekHint', { shortcut: 'Ctrl+Alt+Space' })).toContain('Ctrl+Alt+Space')
    expect(translate('en', 'notch.peekHint')).toContain('{shortcut}')
  })
})
