import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { settingsSchema, type Settings, type SettingsPatch } from '../../shared/settings/schema'
import { ExposedIpcError } from '../ipc/errors'
import type { Logger } from './logger'
import { migrateSettings } from './settings-migrations'

export class SettingsReadOnlyError extends ExposedIpcError {
  constructor() {
    super('READ_ONLY', 'Settings are read-only in this session; changes cannot be saved')
    this.name = 'SettingsReadOnlyError'
  }
}

export interface SettingsStoreOptions {
  filePath: string
  defaults: Settings
  logger: Logger
  now?: () => Date
}

type Listener = (settings: Settings) => void

const isMissingFile = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'

/**
 * Owns `settings.json`: validates on read and write, writes atomically,
 * serializes updates and quarantines files it cannot understand.
 */
export class SettingsStore {
  readonly #filePath: string
  readonly #defaults: Settings
  readonly #log: Logger
  readonly #now: () => Date
  readonly #listeners = new Set<Listener>()
  #current: Settings
  #readOnly = false
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: SettingsStoreOptions) {
    this.#filePath = options.filePath
    this.#defaults = settingsSchema.parse(options.defaults)
    this.#log = options.logger.child('settings')
    this.#now = options.now ?? (() => new Date())
    this.#current = this.#defaults
  }

  /**
   * Never rejects: if the file cannot be read, moved aside or written (locked by antivirus,
   * permissions…), the app still starts with defaults in read-only mode.
   */
  async load(): Promise<Settings> {
    try {
      return await this.#loadFromDisk()
    } catch (error) {
      this.#log.error('Could not load settings; using defaults in read-only mode', { error })
      this.#readOnly = true
      return this.#use(this.#defaults)
    }
  }

  async #loadFromDisk(): Promise<Settings> {
    let text: string
    try {
      text = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await this.#write(this.#defaults)
      return this.#use(this.#defaults)
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return this.#recover('Settings file is not valid JSON')
    }

    const migrated = migrateSettings(raw)
    if (migrated.kind === 'too-new') {
      this.#log.warn('Settings file comes from a newer version; using defaults in read-only mode', {
        version: migrated.version,
      })
      this.#readOnly = true
      return this.#use(this.#defaults)
    }
    if (migrated.kind === 'invalid') return this.#recover('Settings file has no usable version')

    const parsed = settingsSchema.safeParse(migrated.value)
    if (!parsed.success) return this.#recover('Settings file does not match the schema')

    if (migrated.migrated) await this.#write(parsed.data)
    return this.#use(parsed.data)
  }

  get(): Settings {
    return { ...this.#current }
  }

  update(patch: SettingsPatch): Promise<Settings> {
    const run = this.#queue.then(async () => {
      if (this.#readOnly) throw new SettingsReadOnlyError()
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
      // codeReview is merged one level deep: main writes gitlabUrl itself, so a patch of the alerts must not undo it.
      if (patch.codeReview !== undefined) changes['codeReview'] = { ...this.#current.codeReview, ...patch.codeReview }
      const next = settingsSchema.parse({ ...this.#current, ...changes })
      await this.#write(next)
      this.#use(next)
      this.#notify()
      return this.get()
    })
    this.#queue = run.catch(() => undefined)
    return run
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.get())
      } catch (error) {
        this.#log.error('Settings listener failed', { error })
      }
    }
  }

  #use(settings: Settings): Settings {
    this.#current = settings
    return this.get()
  }

  async #recover(reason: string): Promise<Settings> {
    const { dir, name } = parse(this.#filePath)
    const stamp = this.#now().toISOString().replace(/[:.]/g, '-')
    const quarantine = join(dir, `${name}.corrupt-${stamp}.json`)
    await rename(this.#filePath, quarantine)
    this.#log.warn(`${reason}; moved it aside and restored defaults`, { quarantine })
    await this.#write(this.#defaults)
    return this.#use(this.#defaults)
  }

  async #write(settings: Settings): Promise<void> {
    const temp = `${this.#filePath}.tmp`
    await mkdir(dirname(this.#filePath), { recursive: true })
    try {
      await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await rename(temp, this.#filePath)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}
