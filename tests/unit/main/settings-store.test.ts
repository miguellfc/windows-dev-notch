import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsReadOnlyError, SettingsStore } from '../../../src/main/services/settings-store'
import { createDefaultSettings, type Settings } from '../../../src/shared/settings/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

let dir: string
let filePath: string
const defaults = createDefaultSettings('es-ES')
const logger = createMemoryLogger()

const createStore = () => new SettingsStore({ filePath, defaults, logger })
const readSaved = async (): Promise<Settings> => JSON.parse(await readFile(filePath, 'utf8')) as Settings

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notch-settings-'))
  filePath = join(dir, 'nested', 'settings.json')
  logger.entries.length = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsStore.load', () => {
  it('creates the file with defaults on first run', async () => {
    const store = createStore()
    await expect(store.load()).resolves.toEqual(defaults)
    await expect(readSaved()).resolves.toEqual(defaults)
  })

  it('loads valid saved settings', async () => {
    const saved = { ...defaults, language: 'en' as const }
    await createStore().load()
    await writeFile(filePath, JSON.stringify(saved))

    await expect(createStore().load()).resolves.toEqual(saved)
  })

  it('quarantines corrupt JSON and falls back to defaults', async () => {
    await createStore().load()
    await writeFile(filePath, '{ not json')

    const store = createStore()
    await expect(store.load()).resolves.toEqual(defaults)

    const files = await readdir(join(dir, 'nested'))
    expect(files.some((f) => f.startsWith('settings.corrupt-'))).toBe(true)
    await expect(readSaved()).resolves.toEqual(defaults)
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('quarantines files that fail the schema', async () => {
    await createStore().load()
    await writeFile(filePath, JSON.stringify({ ...defaults, language: 'klingon' }))

    await expect(createStore().load()).resolves.toEqual(defaults)
    const files = await readdir(join(dir, 'nested'))
    expect(files.some((f) => f.startsWith('settings.corrupt-'))).toBe(true)
  })

  it('falls back to read-only defaults when the file cannot be read', async () => {
    await mkdir(filePath, { recursive: true }) // a folder where the file should be: EISDIR on read

    const store = createStore()
    await expect(store.load()).resolves.toEqual(defaults)
    await expect(store.update({ language: 'en' })).rejects.toBeInstanceOf(SettingsReadOnlyError)
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('does not overwrite a file written by a newer version and becomes read-only', async () => {
    await createStore().load()
    const newer = JSON.stringify({ version: 99, language: 'en' })
    await writeFile(filePath, newer)

    const store = createStore()
    await expect(store.load()).resolves.toEqual(defaults)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(newer)
    await expect(store.update({ language: 'en' })).rejects.toBeInstanceOf(SettingsReadOnlyError)
  })
})

describe('SettingsStore.update', () => {
  it('merges, persists and notifies listeners', async () => {
    const store = createStore()
    await store.load()
    const listener = vi.fn()
    store.onChange(listener)

    const next = await store.update({ language: 'en', launchAtLogin: true })

    expect(next).toEqual({ ...defaults, language: 'en', launchAtLogin: true })
    expect(store.get()).toEqual(next)
    await expect(readSaved()).resolves.toEqual(next)
    expect(listener).toHaveBeenCalledWith(next)
  })

  it('isolates failing listeners from the update and from each other', async () => {
    const store = createStore()
    await store.load()
    const healthy = vi.fn()
    store.onChange(() => {
      throw new Error('listener bug')
    })
    store.onChange(healthy)

    await expect(store.update({ language: 'en' })).resolves.toMatchObject({ language: 'en' })
    expect(healthy).toHaveBeenCalled()
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('stops notifying after unsubscribe', async () => {
    const store = createStore()
    await store.load()
    const listener = vi.fn()
    const unsubscribe = store.onChange(listener)
    unsubscribe()

    await store.update({ language: 'en' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('applies concurrent updates in order without losing any', async () => {
    const store = createStore()
    await store.load()

    await Promise.all([store.update({ language: 'en' }), store.update({ launchAtLogin: true })])

    expect(store.get()).toEqual({ ...defaults, language: 'en', launchAtLogin: true })
    await expect(readSaved()).resolves.toEqual(store.get())
  })

  it('rejects invalid values and keeps the previous state', async () => {
    const store = createStore()
    await store.load()

    await expect(store.update({ shortcut: 'bad shortcut' })).rejects.toThrow()
    expect(store.get()).toEqual(defaults)
    await expect(readSaved()).resolves.toEqual(defaults)
  })

  it('keeps working after a failed update', async () => {
    const store = createStore()
    await store.load()
    await store.update({ shortcut: '' }).catch(() => undefined)

    await expect(store.update({ language: 'en' })).resolves.toMatchObject({ language: 'en' })
  })

  it('ignores keys explicitly set to undefined when others are present', async () => {
    const store = createStore()
    await store.load()

    await expect(store.update({ language: undefined, launchAtLogin: true })).resolves.toEqual({
      ...defaults,
      launchAtLogin: true,
    })
  })

  it('returns copies so callers cannot mutate internal state', async () => {
    const store = createStore()
    await store.load()
    const snapshot = store.get() as { language: string }
    snapshot.language = 'xx'
    expect(store.get().language).toBe(defaults.language)
  })

  it('leaves no temporary files behind', async () => {
    const store = createStore()
    await store.load()
    await store.update({ language: 'en' })
    const files = await readdir(join(dir, 'nested'))
    expect(files).toEqual(['settings.json'])
  })
})
