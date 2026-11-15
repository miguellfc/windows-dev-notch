import { describe, expect, it, vi } from 'vitest'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import type { ShortcutService } from '../../../src/main/platform/shortcut'
import { createSettingsUpdater } from '../../../src/main/services/settings-update'
import { createDefaultSettings, type Settings } from '../../../src/shared/settings/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const defaults = createDefaultSettings('es')

function setup(options: { current?: string | null; apply?: ShortcutService['apply']; saveFails?: boolean; syncThrows?: boolean } = {}) {
  let current: string | null = options.current === undefined ? 'Control+Alt+Space' : options.current
  const shortcut: ShortcutService = {
    apply: vi.fn((accelerator: string) => {
      const result = options.apply ? options.apply(accelerator) : ({ ok: true } as const)
      if (result.ok) current = accelerator
      return result
    }),
    current: () => current,
    dispose: vi.fn(() => {
      current = null
    }),
  }
  const settings = {
    update: vi.fn(async (patch: Partial<Settings>) => {
      if (options.saveFails) throw new Error('disk full')
      return { ...defaults, ...patch } as Settings
    }),
  }
  const syncLaunchAtLogin = vi.fn(() => {
    if (options.syncThrows) throw new Error('registry locked')
  })
  const logger = createMemoryLogger()
  const update = createSettingsUpdater({ settings, shortcut, syncLaunchAtLogin, logger })
  return { update, shortcut, settings, syncLaunchAtLogin, logger, current: () => current }
}

describe('settings updater', () => {
  it('registers a new shortcut and saves it', async () => {
    const { update, current } = setup()
    await expect(update({ shortcut: 'Alt+N' })).resolves.toMatchObject({ shortcut: 'Alt+N' })
    expect(current()).toBe('Alt+N')
  })

  it('refuses a shortcut taken by another app without saving', async () => {
    const { update, settings } = setup({ apply: () => ({ ok: false, reason: 'unavailable' }) })
    await expect(update({ shortcut: 'Alt+N' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('reports shortcuts Electron rejects as invalid input', async () => {
    const { update } = setup({ apply: () => ({ ok: false, reason: 'invalid' }) })
    const error = await update({ shortcut: 'Alt+N' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExposedIpcError)
    expect(error).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('restores the previous shortcut when saving fails', async () => {
    const { update, current } = setup({ saveFails: true })
    await expect(update({ shortcut: 'Alt+N' })).rejects.toThrow('disk full')
    expect(current()).toBe('Control+Alt+Space')
  })

  it('releases the new shortcut when there was none before and saving fails', async () => {
    const { update, shortcut, current } = setup({ current: null, saveFails: true })
    await expect(update({ shortcut: 'Alt+N' })).rejects.toThrow()
    expect(shortcut.dispose).toHaveBeenCalled()
    expect(current()).toBeNull()
  })

  it('logs when the rollback itself fails', async () => {
    let calls = 0
    const { update, logger } = setup({
      saveFails: true,
      apply: () => (++calls === 1 ? { ok: true } : { ok: false, reason: 'unavailable' }),
    })
    await expect(update({ shortcut: 'Alt+N' })).rejects.toThrow()
    expect(logger.entries.some((e) => e.level === 'error' && /roll back/i.test(e.message))).toBe(true)
  })

  it('keeps saved settings even if start-with-Windows cannot be applied', async () => {
    const { update, current, logger } = setup({ syncThrows: true })
    await expect(update({ shortcut: 'Alt+N', launchAtLogin: true })).resolves.toMatchObject({ launchAtLogin: true })
    expect(current()).toBe('Alt+N')
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('applies start with Windows only when it is part of the patch', async () => {
    const { update, syncLaunchAtLogin } = setup()
    await update({ language: 'en' })
    expect(syncLaunchAtLogin).not.toHaveBeenCalled()
    await update({ launchAtLogin: true })
    expect(syncLaunchAtLogin).toHaveBeenCalledWith(true)
  })
})
