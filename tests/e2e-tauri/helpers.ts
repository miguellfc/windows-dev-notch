/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Helpers for tests/e2e-tauri/app.spec.ts: the Tauri twins of the Electron specs' `app.evaluate`
// calls (the `__e2e:*` channels of `src-tauri/src/e2e.rs`), app restarts and window switching.
//
// Callbacks passed to `browser.execute` are serialized into the page: they cannot use anything
// from this module, only their arguments. The node tsconfig has no DOM lib, hence the casts.
import { kill } from 'node:process'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browser } from '@wdio/globals'
import { createDefaultSettings, type Settings } from '../../src/shared/settings/schema'

/**
 * Runs `script` in the page with `args` and returns its (awaited) result. The result travels as
 * JSON text: WebdriverIO reads any returned object with an `error` key (every refused `Result`)
 * as a WebDriver error, and without the DOM lib its typings turn every return type into an element.
 */
export const inPage = async <R, A extends unknown[]>(script: (...args: A) => R | Promise<R>, ...args: A): Promise<Awaited<R>> => {
  const body = `return (async (...args) => JSON.stringify((await (${script.toString()})(...args)) ?? null))(...arguments)`
  const text = (await (browser.execute as unknown as (this: WebdriverIO.Browser, fn: string, ...rest: A) => Promise<string>).call(
    browser,
    body,
    ...args,
  ))
  return JSON.parse(text) as Awaited<R>
}

export type Envelope<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface WindowInfo {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  alwaysOnTop: boolean
  focused: boolean
  title: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type WindowLabel = 'notch' | 'control-center'

/** The run's profile (`NOTCH_USER_DATA_DIR` of every app this run starts; see wdio.conf.mts). */
export const dataDir = (): string => {
  const dir = process.env['NOTCH_E2E_DATA_DIR']
  if (!dir) throw new Error('NOTCH_E2E_DATA_DIR is not set: run through wdio.conf.mts')
  return dir
}

/** Calls a channel through `notch_ipc` directly (the way `__e2e:*` channels are reached). */
export const ipc = <T = unknown>(channel: string, input?: unknown): Promise<Envelope<T>> =>
  inPage(
    (name: string, value: unknown) =>
      (
        globalThis as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke('notch_ipc', { channel: name, input: value ?? undefined }),
    channel,
    input ?? null,
  ) as Promise<Envelope<T>>

/** An `__e2e:*` call that must succeed; returns its data. */
export const e2e = async <T = unknown>(name: string, input?: unknown): Promise<T> => {
  const result = await ipc<T>(`__e2e:${name}`, input)
  if (!result.ok) throw new Error(`__e2e:${name} failed: ${JSON.stringify(result.error)}`)
  return result.data
}

export const capsuleWindow = async (): Promise<WindowInfo> => {
  const info = await e2e<WindowInfo | null>('window-bounds')
  if (!info) throw new Error('Capsule window not found')
  return info
}

export const controlCenterWindow = (): Promise<WindowInfo | null> =>
  e2e<WindowInfo | null>('window-bounds', { window: 'control-center' })

export const workArea = (): Promise<Rect> => e2e<Rect>('work-area')

/** The pointer enters or leaves the capsule (what the cursor poller reports in the real app). */
export const pointer = (inside: boolean): Promise<unknown> => e2e('pointer', { inside })

/** Switches WebDriver to a window's webview (each one is a window handle of the session). */
export async function useWindow(label: WindowLabel): Promise<void> {
  const page = `/${label}/index.html`
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle)
        if ((await browser.getUrl()).includes(page)) return true
      }
      return false
    },
    { timeout: 15_000, timeoutMsg: `No ${label} webview` },
  )
}

/** The page's `<html lang>`. */
export const pageLang = (): Promise<string> =>
  inPage(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)

/** Waits until `read()` returns something `accept` likes, and returns it. */
export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeout = 10_000): Promise<T> {
  let last: T | undefined
  try {
    await browser.waitUntil(
      async () => {
        last = await read()
        return accept(last)
      },
      { timeout, interval: 100 },
    )
  } catch {
    throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(last)}`)
  }
  return last as T
}

let appPid: number | undefined
/** The current session started an app whose pid was never read (the runner's first session, or a failed launch). */
let sessionAppUnknown = true

const alive = (pid: number): boolean => {
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Quits the running app the way the tray does (the ordered quit that saves the usage log) and
 * waits for its process to end. Kills it only if it hangs; it is always a process this run started.
 */
export async function quitApp(): Promise<void> {
  const pid = appPid
  appPid = undefined
  if (pid === undefined || !alive(pid)) return
  await ipc('__e2e:quit').catch(() => undefined)
  const deadline = Date.now() + 15_000
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  if (alive(pid)) {
    kill(pid)
    throw new Error(`The app (pid ${pid}) did not quit`)
  }
}

export interface LaunchOptions {
  /** Empty the profile first. */
  fresh: boolean
  /**
   * `NOTCH_*` switches for this app only (tauri-driver gives every session the environment it
   * started with): passed as `--e2e-env-NAME=VALUE` arguments, which the `e2e` build applies
   * before anything reads the environment (`e2e::apply_cli_env`).
   */
  env?: Record<string, string>
  /** Files written into the profile before the app starts (`settings.json`, `reminders.json`...). */
  files?: Record<string, unknown>
}

/**
 * Starts the app in a new WebDriver session (tauri-driver launches a new process), on the notch
 * webview once the capsule is on screen. `fresh` empties the profile first.
 */
export async function launch({ fresh, env = {}, files = {} }: LaunchOptions): Promise<void> {
  // The first launch (or one after a failed launch) does not know the pid of the app the current
  // session started, which still writes into the profile: adopt it so it is quit before the
  // profile is emptied (Windows cannot delete its open log file).
  if (sessionAppUnknown) {
    sessionAppUnknown = false
    try {
      await useWindow('notch')
      appPid = await e2e<number>('pid')
    } catch {
      // No live app in this session.
    }
  }
  await quitApp()
  if (fresh) {
    for (const entry of readdirSync(dataDir())) {
      rmSync(join(dataDir(), entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dataDir(), name), JSON.stringify(value), 'utf8')
  }
  sessionAppUnknown = true
  const application = process.env['NOTCH_E2E_APP']
  if (!application) throw new Error('NOTCH_E2E_APP is not set: run through wdio.conf.mts')
  // One switch per variable: msedgedriver passes them on as Chromium switches (one value per name).
  const args = Object.entries(env).map(([name, value]) => `--e2e-env-${name}=${value}`)
  await browser.reloadSession({ 'tauri:options': { application, args } } as WebdriverIO.Capabilities)
  await useWindow('notch')
  await browser.$('[data-testid="notch-capsule"]').waitForDisplayed({ timeout: 20_000 })
  appPid = await e2e<number>('pid')
  sessionAppUnknown = false
}

/**
 * `settings.json` as the Electron specs seed it (Spanish, reminders without sound, these system
 * alerts). GAP: Electron writes a version 3 file and its store migrates it; the Rust store has no
 * migrations (an older version is quarantined), so the same values go into a current-version file.
 */
export const seededSettings = (systemAlerts: Settings['systemAlerts']): Settings => ({
  ...createDefaultSettings('es'),
  language: 'es',
  shortcut: 'Control+Alt+Space',
  launchAtLogin: false,
  reminders: { snoozeMinutes: 10, sound: false },
  systemAlerts,
})

/** Every system alert on, at the defaults (the seed of the notes and reminders specs). */
export const DEFAULT_ALERTS = {
  cpu: { enabled: true, percent: 90, sustainSeconds: 30 },
  ram: { enabled: true, percent: 90 },
  battery: { enabled: true, percent: 15 },
  disk: { enabled: true, freePercent: 10 },
}

/** Saves the language through the page's own API. */
export const setLanguage = async (language: 'es' | 'en'): Promise<void> => {
  const saved = await inPage(
    (value) =>
      (
        globalThis as unknown as { notch: { settings: { update(patch: unknown): Promise<unknown> } } }
      ).notch.settings.update({ language: value }),
    language,
  )
  if (!(saved as { ok?: boolean } | null)?.ok) throw new Error(`settings.update failed: ${JSON.stringify(saved)}`)
}

/** `window.notch.notch.request({ intent })`. */
export const requestIntent = (intent: 'expand' | 'toggle' | 'dismiss'): Promise<unknown> =>
  inPage(
    (value) =>
      (globalThis as unknown as { notch: { notch: { request(input: unknown): Promise<unknown> } } }).notch.notch.request({
        intent: value,
      }),
    intent,
  )

/** Opens the Control Center from the notch and switches WebDriver to it. */
export async function openControlCenter(): Promise<void> {
  await inPage(() => (globalThis as unknown as { notch: { app: { openControlCenter(): Promise<unknown> } } }).notch.app.openControlCenter())
  await useWindow('control-center')
  await browser.$('h1').waitForDisplayed()
}

/**
 * Playwright's `fill`: focuses the field and sets its whole value at once (a date input takes
 * WebDriver keystrokes in the OS locale's order, and a cleared React field keeps its old state):
 * the native setter, then the `input` and `change` events React listens to.
 */
export const fillValue = (selector: string, value: string): Promise<void> =>
  inPage(
    (sel: string, text: string) => {
      type Input = { dispatchEvent(event: unknown): boolean; focus(): void; tagName: string }
      const w = globalThis as unknown as {
        document: { querySelector(s: string): Input | null }
        HTMLInputElement: { prototype: object }
        HTMLTextAreaElement: { prototype: object }
        Event: new (type: string, init: Record<string, unknown>) => unknown
      }
      const el = w.document.querySelector(sel)
      if (!el) throw new Error(`No element ${sel}`)
      el.focus()
      const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(el, text)
      el.dispatchEvent(new w.Event('input', { bubbles: true }))
      el.dispatchEvent(new w.Event('change', { bubbles: true }))
    },
    selector,
    value,
  )

/** Moves WebDriver's virtual pointer to the top-left corner of the page (`mouse.move(1, 1)`). */
export const pointerToCorner = (): Promise<void> =>
  browser.action('pointer').move({ x: 1, y: 1, origin: 'viewport' }).perform()

/** A computed style of the first element matching `selector`. */
export const cssOf = (selector: string, property: string): Promise<string | null> =>
  inPage(
    (sel: string, prop: string) => {
      const w = globalThis as unknown as {
        document: { querySelector(s: string): unknown }
        getComputedStyle(el: unknown): { getPropertyValue(p: string): string }
      }
      const el = w.document.querySelector(sel)
      return el ? w.getComputedStyle(el).getPropertyValue(prop) : null
    },
    selector,
    property,
  )

/** Whether the process `pid` is running (signal 0). */
export const isAlive = alive

/**
 * Stable replacement for fixed sleeps (tests/e2e/settle.ts): resolves once fonts are loaded and,
 * for two painted frames in a row, no finite animation runs and the capsule has its mode's size.
 */
export const settle = (): Promise<void> =>
  inPage(async () => {
    type Size = { width: number; height: number }
    type Doc = {
      fonts: { ready: Promise<unknown> }
      getAnimations: () => { finished: Promise<unknown>; effect: { getComputedTiming: () => { endTime: number | string } } | null }[]
      querySelector: (selector: string) => { getBoundingClientRect: () => Size; style: { width: string; height: string } } | null
    }
    const w = globalThis as unknown as { document: Doc; requestAnimationFrame: (cb: () => void) => void }
    const finite = () => w.document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
    const frame = () => new Promise<void>((resolve) => w.requestAnimationFrame(() => resolve()))
    const atTargetSize = (): boolean => {
      const el = w.document.querySelector('[data-testid="notch-capsule"]')
      if (!el) return true
      const box = el.getBoundingClientRect()
      return Math.abs(box.width - parseFloat(el.style.width)) < 0.5 && Math.abs(box.height - parseFloat(el.style.height)) < 0.5
    }
    await w.document.fonts.ready
    let stable = 0
    for (let i = 0; i < 300 && stable < 2; i++) {
      await Promise.all(finite().map((a) => a.finished.catch(() => undefined)))
      await frame()
      stable = finite().length === 0 && atTargetSize() ? stable + 1 : 0
    }
  })

/** The painted capsule's box in the page (CSS px). */
export const capsuleBox = (): Promise<Rect> =>
  inPage(() => {
    const el = (
      globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): Rect } | null } }
    ).document.querySelector('[data-testid="notch-capsule"]')
    if (!el) throw new Error('No capsule')
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  })

/**
 * A left or right click on the capsule as a bare DOM event. A WebDriver click first moves its
 * virtual pointer onto the capsule, and the pointer events that follow would reach the controller
 * through `notch:pointer` (live in the `e2e` build). In the real app hover comes from the cursor
 * poller only, so the specs drive it with `pointer()` alone and keep clicks free of hover.
 */
export const clickCapsule = (button: 'left' | 'right' = 'left'): Promise<void> =>
  inPage((which: string) => {
    type El = { dispatchEvent(event: unknown): boolean }
    const w = globalThis as unknown as {
      document: { querySelector(s: string): El | null }
      MouseEvent: new (type: string, init: Record<string, unknown>) => unknown
    }
    const el = w.document.querySelector('[data-testid="notch-capsule"]')
    if (!el) throw new Error('No capsule')
    const init = { bubbles: true, cancelable: true, button: which === 'right' ? 2 : 0 }
    el.dispatchEvent(new w.MouseEvent(which === 'right' ? 'contextmenu' : 'click', init))
  }, button)

/** The first element matching `selector`: its box in the page (CSS px), `null` when absent. */
export const rectOf = (selector: string): Promise<Rect | null> =>
  inPage((sel: string) => {
    const el = (
      globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): Rect } | null } }
    ).document.querySelector(sel)
    if (!el) return null
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  }, selector)

/** The bottom of the panel's clock (the first element whose whole text is HH:mm), in page px. */
export const clockBottom = (): Promise<number | null> =>
  inPage(() => {
    const doc = (
      globalThis as unknown as {
        document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null; getBoundingClientRect(): { bottom: number } }> }
      }
    ).document
    const el = Array.from(doc.querySelectorAll('span, time, div, p')).find((node) => /^[0-9]{2}:[0-9]{2}$/.test(node.textContent ?? ''))
    return el ? el.getBoundingClientRect().bottom : null
  })
