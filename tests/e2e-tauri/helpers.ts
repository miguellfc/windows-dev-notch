/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Helpers for tests/e2e-tauri/app.spec.ts: the Tauri twins of the Electron specs' `app.evaluate`
// calls (the `__e2e:*` channels of `src-tauri/src/e2e.rs`), app restarts and window switching.
//
// Callbacks passed to `browser.execute` are serialized into the page: they cannot use anything
// from this module, only their arguments. The node tsconfig has no DOM lib, hence the casts.
import { kill } from 'node:process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { browser } from '@wdio/globals'

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

/**
 * Starts the app in a new WebDriver session (tauri-driver launches a new process), on the notch
 * webview once the capsule is on screen. `fresh` empties the profile first.
 */
export async function launch({ fresh }: { fresh: boolean }): Promise<void> {
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
  sessionAppUnknown = true
  await browser.reloadSession()
  await useWindow('notch')
  await browser.$('[data-testid="notch-capsule"]').waitForDisplayed({ timeout: 20_000 })
  appPid = await e2e<number>('pid')
  sessionAppUnknown = false
}

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
