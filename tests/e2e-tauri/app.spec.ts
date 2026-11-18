/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// End-to-end tests of the Tauri app, ported from 0.1.0's Electron e2e app.spec.ts. Each test starts
// its own app (fresh profile, no foreground watcher, no cursor poller, test clock) through
// tauri-driver; `npm run test:e2e` builds it with the `e2e` feature first.
//
// Hover is what the cursor poller reports in the real app; here `pointer()` (`__e2e:pointer`) stands
// in for it, so the user's real cursor never matters. The global shortcut is `__e2e:shortcut`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import type { NotchApi } from '../../src/shared/ipc/api'
import {
  capsuleBox,
  capsuleWindow,
  clickCapsule,
  controlCenterWindow,
  dataDir,
  e2e,
  eventually,
  inPage,
  ipc,
  launch,
  pageLang,
  pointer,
  quitApp,
  settle,
  useWindow,
  workArea,
} from './helpers'

type NotchWindow = { notch: NotchApi; require?: unknown; process?: unknown }

const capsule = () => $('[data-testid="notch-capsule"]')
const mode = () => capsule().getAttribute('data-mode')
const expectMode = (value: string) => expect(capsule()).toHaveAttribute('data-mode', value)

/** The capsule holds `value` for ~500 ms (no flicker). */
async function stays(value: string): Promise<void> {
  const seen: (string | null)[] = []
  for (let i = 0; i < 10; i++) {
    seen.push(await mode())
    await browser.pause(50)
  }
  expect(seen).toEqual(Array(10).fill(value))
}

/** The capsule window is focused and is the OS foreground window (an open panel). */
async function expectPanelFocused(): Promise<void> {
  await eventually(capsuleWindow, (w) => w.focused, 'the panel to take the focus')
  await eventually(() => e2e<boolean>('foreground-is-ours'), (ours) => ours, 'the panel in the foreground')
}

const request = (intent: 'expand' | 'toggle') =>
  inPage((value) => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: value }), intent)

/**
 * Saves the language. `<html lang>` follows it only while a translated view is mounted (the
 * panel, not the bare capsule), so callers check it where it applies.
 */
const setLanguage = async (language: 'es' | 'en') => {
  const saved = await inPage((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)
  expect(saved).toMatchObject({ ok: true, data: { language } })
}

const expectPageLang = (language: 'es' | 'en', what = `the page in ${language}`) =>
  eventually(pageLang, (lang) => lang === language, what)

/** Opens the Control Center from the notch and switches WebDriver to it. */
async function openControlCenter(): Promise<void> {
  await inPage(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  await useWindow('control-center')
  await $('h1').waitForDisplayed()
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(dataDir(), file), 'utf8')) as T

describe('Developer Notch (Tauri)', () => {
  beforeEach(async () => {
    await launch({ fresh: true })
  })

  after(async () => {
    await quitApp()
  })

  it('renderer is isolated and locked down by CSP', async () => {
    const exposure = await inPage(() => {
      const win = globalThis as unknown as NotchWindow
      return {
        require: typeof win.require,
        process: typeof win.process,
        frozen: Object.isFrozen(win.notch),
        writable: Object.getOwnPropertyDescriptor(win, 'notch')?.writable ?? null,
        keys: Object.keys(win.notch).sort(),
      }
    })
    expect(exposure).toEqual({
      require: 'undefined',
      process: 'undefined',
      frozen: true,
      writable: false,
      keys: ['app', 'apps', 'claude', 'codeReview', 'events', 'gmail', 'notch', 'notes', 'redmine', 'reminders', 'settings', 'system', 'usage'],
    })

    const csp = await $('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(/script-src 'self';/)
    expect(csp).not.toContain('unsafe-eval')
    // Only styles are relaxed (inline styles injected at runtime).
    expect(csp?.match(/'unsafe-inline'/g)).toHaveLength(1)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    // Tauri's IPC endpoint is allowed, so calls do not fall back to postMessage with a violation.
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost;")

    // The webviews may only listen to events: no emit (forging events into the other window), no
    // tray or menu commands. Each refusal must come from the ACL, not from bad arguments.
    const acl = await inPage(async (calls: [string, Record<string, unknown>][]) => {
      const internals = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } })
        .__TAURI_INTERNALS__
      const results: Record<string, string> = {}
      for (const [cmd, args] of calls) {
        try {
          await internals.invoke(cmd, args)
          results[cmd] = 'allowed'
        } catch (error) {
          results[cmd] = /not allowed/i.test(String(error)) ? 'denied' : `failed: ${String(error)}`
        }
      }
      return results
    }, [
      ['plugin:event|emit', { event: 'settings:changed', payload: {} }],
      ['plugin:event|emit_to', { target: { kind: 'Any' }, event: 'notch:mode-changed', payload: 'expanded' }],
      ['plugin:tray|remove_by_id', { id: 'main' }],
      ['plugin:tray|new', { options: {} }],
      ['plugin:menu|new', { kind: 'Menu', options: {} }],
      ['plugin:window|set_focus', { label: 'notch' }],
    ] as [string, Record<string, unknown>][])
    expect(acl).toEqual({
      'plugin:event|emit': 'denied',
      'plugin:event|emit_to': 'denied',
      'plugin:tray|remove_by_id': 'denied',
      'plugin:tray|new': 'denied',
      'plugin:menu|new': 'denied',
      'plugin:window|set_focus': 'denied',
    })

    const invalid = await inPage(() =>
      (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'explode' as 'expand' }),
    )
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('capsule floats at the top, grows to the panel and shrinks back', async () => {
    const area = await workArea()
    const compact = await eventually(capsuleWindow, (w) => w.visible, 'the capsule window shown')
    expect(compact).toMatchObject({ visible: true, alwaysOnTop: true, y: area.y, title: 'Developer Notch' })
    // At rest the capsule peeks (time and date only).
    await expectMode('peek')

    await request('expand')
    await expectMode('expanded')
    await eventually(capsuleWindow, (w) => w.height > compact.height, 'the window to grow')

    await browser.keys('Escape')
    await expectMode('peek')
    await eventually(capsuleWindow, (w) => w.height === compact.height, 'the window to shrink back')
  })

  it('capsule modes: peek, compact on hover, right click pins, left click unpins', async () => {
    await setLanguage('es')
    const area = await workArea()

    // Peek, the resting capsule: time and date, no shortcut keycaps, no metrics.
    await expectMode('peek')
    await expect(capsule().$$('kbd')).toBeElementsArrayOfSize(0)
    await expect($$('[data-testid="capsule-metrics"]')).toBeElementsArrayOfSize(0)
    const peek = await capsuleWindow()

    // Pointer in: compact (with the system metrics), same window height (only the width morphs).
    await pointer(true)
    await expectMode('compact')
    await $('[data-testid="capsule-metrics"]').waitForDisplayed({ timeout: 10_000 })
    await stays('compact')
    expect((await capsuleWindow()).height).toBe(peek.height)

    // Pointer out: back to peek.
    await pointer(false)
    await expectMode('peek')

    // Only the painted capsule hits: its centre does, its rounded corner does not.
    // GAP: Electron also moves the real pointer 2 px above and below the capsule (its shadow room);
    // in Tauri that hit test is the cursor poller's (`notch/cursor.rs`, unit tested), which an E2E
    // test could only reach by moving the user's real cursor.
    await settle()
    const peekBox = await capsuleBox()
    const hitAt = (x: number, y: number) =>
      inPage(
        (px, py) =>
          (
            globalThis as unknown as {
              document: { elementFromPoint(x: number, y: number): { closest(s: string): unknown } | null }
            }
          ).document
            .elementFromPoint(px, py)
            ?.closest('[data-testid="notch-capsule"]') != null,
        x,
        y,
      )
    expect(await hitAt(peekBox.x + peekBox.width / 2, peekBox.y + peekBox.height / 2)).toBe(true)
    expect(await hitAt(peekBox.x + 1, peekBox.y + 1)).toBe(false)

    // Right click on compact: the thin pill, flush against the top edge of the screen.
    await pointer(true)
    await expectMode('compact')
    await clickCapsule('right')
    await expectMode('mini')
    await eventually(capsuleWindow, (w) => w.height < peek.height, 'the window to shrink to the pill')
    expect((await capsuleWindow()).y).toBe(area.y)
    await settle()
    const pill = await capsuleBox()
    expect(pill.y).toBe(0)
    expect(pill.height).toBeLessThanOrEqual(5)

    // The pointer on the pill (and leaving it) keeps the pill.
    await pointer(false)
    await pointer(true)
    await browser.pause(300)
    await expectMode('mini')
    await pointer(false)

    // Left click on the pill: compact, which sticks while the pointer is off it, then peek once the
    // pointer has been on compact and leaves it.
    await clickCapsule('left')
    await expectMode('compact')
    await pointer(false)
    await stays('compact')
    await pointer(true)
    await expectMode('compact')
    await pointer(false)
    await expectMode('peek')

    // Hover again: compact; a left click opens the panel.
    await pointer(true)
    await expectMode('compact')
    await stays('compact')
    await clickCapsule('left')
    await expectMode('expanded')
  })

  it('pinned pill takes the panel from the shortcut and returns', async () => {
    await pointer(true)
    await expectMode('compact')
    await clickCapsule('right')
    await expectMode('mini')
    await pointer(false)

    // The global shortcut toggles the panel over the pill; closing it goes back to the pill.
    await e2e('shortcut')
    await expectMode('expanded')
    await browser.keys('Escape')
    await expectMode('mini')

    // The pill is not remembered after a restart.
    await launch({ fresh: false })
    await expectMode('peek')
  })

  it('hide from the panel removes the capsule without quitting', async () => {
    await setLanguage('en')
    await request('expand')
    await expectMode('expanded')
    await expectPageLang('en')
    await capsule().$('button[aria-label="Hide"]').click()
    await eventually(capsuleWindow, (w) => !w.visible, 'the capsule hidden')

    await request('toggle')
    await eventually(capsuleWindow, (w) => w.visible, 'the capsule shown again')
    await expectMode('expanded')
  })

  it('panel header icon buttons reachable with Tab', async () => {
    await setLanguage('en')
    await request('expand')
    await expectMode('expanded')
    // The panel really holds the OS focus (keys reach it), not just the page's activeElement.
    await expectPanelFocused()
    await expectPageLang('en')

    const controlCenter = capsule().$('header').$('button[aria-label="Control Center"]')
    const hide = capsule().$('header').$('button[aria-label="Hide"]')
    await expect(controlCenter).toBeDisplayed()
    await expect(hide).toBeDisplayed()
    await settle()
    expect((await controlCenter.getSize()).width).toBe(28)
    expect((await hide.getSize()).height).toBe(28)
    const text = await capsule().getText()
    expect(text).not.toMatch(/Esc para cerrar|Esc to close/)

    // Both are in the Tab order (before the tiles, which follow the header).
    const focusedLabel = () =>
      inPage(
        () =>
          (
            globalThis as unknown as { document: { activeElement: { getAttribute(name: string): string | null } | null } }
          ).document.activeElement?.getAttribute('aria-label') ?? null,
      )
    await browser.keys('Tab')
    await eventually(focusedLabel, (label) => label === 'Control Center', 'focus on Control Center')
    await browser.keys('Tab')
    await eventually(focusedLabel, (label) => label === 'Hide', 'focus on Hide')

    // Control Center opens its window; the panel closes at once, and the new window shows (and
    // takes the focus) once its first paint is ready.
    await controlCenter.click()
    await eventually(mode, (value) => value !== 'expanded', 'the panel to close')
    await eventually(controlCenterWindow, (w) => w !== null && w.visible && w.focused, 'the Control Center shown and focused')
    // The foreground check the focus test relies on does see our own windows.
    expect(await e2e<boolean>('foreground-is-ours')).toBe(true)

    // Open the panel again; Hide hides the notch.
    await request('expand')
    await expectMode('expanded')
    // The panel re-mounts and grows: click Hide once it has stopped moving (a click on the
    // stale, still-animating button could land beside it).
    await settle()
    await hide.click()
    await eventually(capsuleWindow, (w) => !w.visible, 'the capsule hidden')
  })

  it('panel takes the OS focus and gives it back when dismissed', async () => {
    await request('expand')
    await expectMode('expanded')
    await expectPanelFocused()

    await browser.keys('Escape')
    await expectMode('peek')
    await eventually(capsuleWindow, (w) => !w.focused, 'the capsule to lose the focus')
    await eventually(() => e2e<boolean>('foreground-is-ours'), (ours) => !ours, 'the foreground handed back')
  })

  it('nine tiles fit in ES and EN', async () => {
    await request('expand')
    await expectMode('expanded')
    for (const language of ['es', 'en'] as const) {
      await setLanguage(language)
      await expectPageLang(language)
      const measureFit = () =>
        inPage(() => {
          interface El {
            querySelector(selector: string): El | null
            scrollWidth: number
            clientWidth: number
            parentElement: El | null
            getBoundingClientRect(): { left: number; right: number }
            dataset: Record<string, string | undefined>
          }
          const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<El> } }).document
          const tiles = Array.from(doc.querySelectorAll('[data-testid^="integration-"]:not([data-testid$="-badge"]):not([data-testid$="-label"])'))
          const row = tiles[0]?.parentElement
          return {
            count: tiles.length,
            cut: tiles
              .filter((tile) => {
                const label = tile.querySelector('[data-testid$="-label"]')
                return !label || label.scrollWidth > label.clientWidth
              })
              .map((tile) => tile.dataset['testid']),
            // Rects, not scrollWidth: sub-pixel tile widths round the row's scrollWidth up by 1 px.
            rowOverflows: row
              ? tiles.some((tile) => tile.getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5)
              : true,
          }
        })
      // Polled: the labels re-render with the language a frame after `lang` changes.
      await eventually(
        measureFit,
        (fit) => fit.count === 9 && fit.cut.length === 0 && !fit.rowOverflows,
        `nine tiles fitting in ${language}`,
      )
    }
  })

  it('Control Center changes language live and persists it', async () => {
    // Start from English, so choosing Español is a change whatever the system language.
    await setLanguage('en')
    await openControlCenter()
    await $('aria/Español').click()
    await $('aria/Atajo').waitForDisplayed()
    await useWindow('notch')
    // Seen live from the panel (see setLanguage).
    await request('expand')
    await expectPageLang('es', 'the notch in Spanish')

    await useWindow('control-center')
    const saved = await inPage(() =>
      (globalThis as unknown as NotchWindow).notch.settings.update({ shortcut: 'Alt+Shift+F9' }),
    )
    expect(saved).toMatchObject({ ok: true, data: { shortcut: 'Alt+Shift+F9' } })
    await quitApp()

    expect(readJson<Record<string, unknown>>('settings.json')).toMatchObject({ language: 'es', shortcut: 'Alt+Shift+F9' })

    await launch({ fresh: false })
    const runtime = await inPage(() => (globalThis as unknown as NotchWindow).notch.app.getRuntime())
    expect(runtime).toMatchObject({ ok: true, data: { shortcutRegistered: true } })
    await request('expand')
    await expectPageLang('es', 'the notch in Spanish after a restart')
  })

  it('About shows usage and quitting saves it', async () => {
    // The summary is for the Control Center only.
    const fromNotch = await ipc('usage:summary', { days: 14 })
    expect(fromNotch).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    await openControlCenter()
    await $('aria/English').click()
    await $('aria/About').click()

    // The usage block is a region named by its heading.
    const usage = $('section[aria-labelledby="usage-title"]')
    await usage.waitForDisplayed()
    await expect(usage.$('#usage-title')).toHaveText('Usage (last 14 days)')
    // This launch is already counted.
    await expect(usage.$$('dd')[2]).toHaveText('1')
    await expect(usage.$('p=Stored only on this PC.')).toBeDisplayed()
    await usage.$('aria/7 days').click()
    await expect(usage.$('#usage-title')).toHaveText('Usage (last 7 days)')

    await quitApp()
    const saved = readJson<{ version: number; days: Record<string, { launches: number }> }>('usage.json')
    expect(saved.version).toBe(1)
    expect(Object.values(saved.days).reduce((sum, day) => sum + day.launches, 0)).toBe(1)
  })

  it('capsule never takes focus in peek, compact or alert', async () => {
    const notOurs = async (what: string) => {
      await browser.pause(300)
      expect({ what, ours: await e2e<boolean>('foreground-is-ours') }).toEqual({ what, ours: false })
      expect({ what, focused: (await capsuleWindow()).focused }).toEqual({ what, focused: false })
    }
    await expectMode('peek')
    await notOurs('peek')

    await pointer(true)
    await expectMode('compact')
    await notOurs('compact')
    await pointer(false)
    await expectMode('peek')

    // The new-mail alert (the alert part 1 can raise), then the test clock past its 6 s.
    await e2e('mail-alert', { on: true })
    await expectMode('alert')
    await notOurs('alert')
    await e2e('advance-clock', { ms: 10_000 })
    await expectMode('peek')
    await notOurs('peek after the alert')
  })
})
