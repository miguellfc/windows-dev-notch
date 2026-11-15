import { describe, expect, it, vi } from 'vitest'
import { createShortcutService, type ShortcutRegistrar } from '../../../src/main/platform/shortcut'
import { createMemoryLogger } from '../helpers/memory-logger'

function setup(taken: string[] = [], invalid: string[] = []) {
  const registered = new Set<string>()
  const registrar: ShortcutRegistrar = {
    register: (accelerator) => {
      if (invalid.includes(accelerator)) throw new TypeError('Invalid accelerator')
      if (taken.includes(accelerator)) return false
      registered.add(accelerator)
      return true
    },
    unregister: (accelerator) => {
      registered.delete(accelerator)
    },
  }
  const onTrigger = vi.fn()
  const service = createShortcutService({ registrar, onTrigger, logger: createMemoryLogger() })
  return { service, registered, onTrigger }
}

describe('shortcut service', () => {
  it('registers the first shortcut', () => {
    const { service, registered } = setup()
    expect(service.apply('Control+Alt+Space')).toEqual({ ok: true })
    expect([...registered]).toEqual(['Control+Alt+Space'])
    expect(service.current()).toBe('Control+Alt+Space')
  })

  it('swaps to a new shortcut and releases the old one', () => {
    const { service, registered } = setup()
    service.apply('Control+Alt+Space')
    expect(service.apply('Alt+N')).toEqual({ ok: true })
    expect([...registered]).toEqual(['Alt+N'])
  })

  it('reports a shortcut taken by another app and keeps the previous one', () => {
    const { service, registered } = setup(['Alt+N'])
    service.apply('Control+Alt+Space')
    expect(service.apply('Alt+N')).toEqual({ ok: false, reason: 'unavailable' })
    expect([...registered]).toEqual(['Control+Alt+Space'])
    expect(service.current()).toBe('Control+Alt+Space')
  })

  it('reports accelerators Electron rejects', () => {
    const { service } = setup([], ['Foo+Bar'])
    expect(service.apply('Foo+Bar')).toEqual({ ok: false, reason: 'invalid' })
    expect(service.current()).toBeNull()
  })

  it('treats re-applying the same shortcut as a no-op', () => {
    const { service, registered } = setup()
    service.apply('Alt+N')
    expect(service.apply('Alt+N')).toEqual({ ok: true })
    expect([...registered]).toEqual(['Alt+N'])
  })

  it('releases everything on dispose', () => {
    const { service, registered } = setup()
    service.apply('Alt+N')
    service.dispose()
    expect(registered.size).toBe(0)
    expect(service.current()).toBeNull()
  })
})
