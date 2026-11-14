import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi; require?: unknown; process?: unknown }
interface WindowInfo {
  title: string
  height: number
  y: number
  visible: boolean
  alwaysOnTop: boolean
}

let userData: string

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  // Keep the capsule independent of whatever window happens to be in front during the run.
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Never touch the real ~/.claude/settings.json nor collide with an installed notch on 47600.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const capsuleWindow = async (app: ElectronApplication): Promise<WindowInfo> => {
  const all = (await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      title: w.getTitle(),
      height: w.getBounds().height,
      y: w.getBounds().y,
      visible: w.isVisible(),
      alwaysOnTop: w.isAlwaysOnTop(),
    })),
  )) as WindowInfo[]
  const found = all.find((w) => w.title === 'Developer Notch')
  if (!found) throw new Error('Capsule window not found')
  return found
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
})

test.afterEach(() => {
  // Windows can keep a profile file locked for a moment after Electron exits.
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('renderer is isolated from Node and locked down by CSP', async () => {
  const { app, notch } = await launch()

  const exposure = await notch.evaluate(() => {
    const win = globalThis as unknown as NotchWindow
    return { require: typeof win.require, process: typeof win.process, keys: Object.keys(win.notch).sort() }
  })
  expect(exposure).toEqual({ require: 'undefined', process: 'undefined', keys: ['app', 'apps', 'claude', 'codeReview', 'events', 'gmail', 'notch', 'notes', 'reminders', 'settings', 'system', 'usage'] })

  const csp = await notch.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("default-src 'none'")
  expect(csp).toMatch(/script-src 'self';/)
  expect(csp).not.toContain('unsafe-eval')
  // Only styles are relaxed (inline styles injected at runtime).
  expect(csp?.match(/'unsafe-inline'/g)).toHaveLength(1)
  expect(csp).toContain("style-src 'self' 'unsafe-inline'")

  const invalid = await notch.evaluate(() =>
    (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'explode' as 'expand' }),
  )
  expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

  await app.close()
})

test('capsule floats at the top, grows to the panel and shrinks back', async () => {
  const { app, notch } = await launch()

  const compact = await capsuleWindow(app)
  expect(compact).toMatchObject({ visible: true, alwaysOnTop: true, y: 0 })
  // At rest the capsule peeks (time and date only).
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'peek')

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  await expect.poll(async () => (await capsuleWindow(app)).height).toBeGreaterThan(compact.height)

  await notch.keyboard.press('Escape')
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'peek')
  await expect.poll(async () => (await capsuleWindow(app)).height).toBe(compact.height)

  await app.close()
})

test('capsule modes: peek at rest, compact on hover, right click pins the pill to the top edge, left click unpins', async () => {
  const { app, notch } = await launch()
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.settings.update({ language: 'es' }))
  await expect
    .poll(() => notch.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang))
    .toBe('es')
  const capsule = notch.getByTestId('notch-capsule')
  /** The capsule holds `mode` for ~500 ms (no flicker under a still pointer). */
  const stays = async (mode: string) => {
    const seen: (string | null)[] = []
    for (let i = 0; i < 10; i++) {
      seen.push(await capsule.getAttribute('data-mode'))
      await notch.waitForTimeout(50)
    }
    expect(seen).toEqual(Array(10).fill(mode))
  }
  const staysCompact = () => stays('compact')
  /** The painted capsule, once its morph is over. */
  const paintedBox = async () => {
    await settle(notch)
    const box = await capsule.boundingBox()
    expect(box).not.toBeNull()
    return box!
  }
  // Real pointer events. Playwright's mouse is virtual: when main stops ignoring the mouse, Windows can
  // report the real cursor (elsewhere on the desktop) leaving the window, so the hover itself is retried
  // until it lands (tests/e2e/pointer.ts explains the IPC shortcut the other specs use instead); once it
  // has, the capsule must hold compact (checked outside the retry, so a flicker is never masked).
  const hoverIntoCompact = async () => {
    await expect(async () => {
      await notch.mouse.move(1, 40)
      await capsule.hover()
      await expect(capsule).toHaveAttribute('data-mode', 'compact', { timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    await staysCompact()
  }
  /** Horizontal centre of the capsule column (the window is centred on the work area). */
  const centreX = async () => {
    const box = await capsule.boundingBox()
    return box!.x + box!.width / 2
  }
  const workAreaTop = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea.y)

  // Peek, the resting capsule: time and date, no shortcut keycaps, no metrics.
  await expect(capsule).toHaveAttribute('data-mode', 'peek')
  await expect(capsule.locator('kbd')).toHaveCount(0)
  await expect(notch.getByTestId('capsule-metrics')).toHaveCount(0)
  const peek = await capsuleWindow(app)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/capsule-modes-peek-es.png' })

  // Pointer in: compact (metrics), same window height (only the width morphs).
  await hoverIntoCompact()
  await expect(notch.getByTestId('capsule-metrics')).toBeVisible({ timeout: 10_000 })
  expect((await capsuleWindow(app)).height).toBe(peek.height)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/capsule-modes-compact-es.png' })

  // Pointer out: back to peek.
  await notch.mouse.move(1, 1)
  await expect(capsule).toHaveAttribute('data-mode', 'peek')

  // Only the painted capsule hovers: 2 px above or below it (its shadow room) does nothing, in peek and
  // in compact, and its rounded corners are not part of it either.
  const peekBox = await paintedBox()
  const cx = peekBox.x + peekBox.width / 2
  for (const y of [peekBox.y - 2, peekBox.y + peekBox.height + 2]) {
    await notch.mouse.move(cx, y)
    await stays('peek')
  }
  const hitAt = (x: number, y: number) =>
    notch.evaluate(
      ([px, py]) =>
        (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { closest(s: string): unknown } | null } }).document
          .elementFromPoint(px!, py!)
          ?.closest('[data-testid="notch-capsule"]') != null,
      [x, y],
    )
  expect(await hitAt(cx, peekBox.y + peekBox.height / 2)).toBe(true)
  expect(await hitAt(peekBox.x + 1, peekBox.y + 1)).toBe(false)
  await notch.mouse.move(cx, peekBox.y + peekBox.height / 2)
  await expect(capsule).toHaveAttribute('data-mode', 'compact')
  const compactBox = await paintedBox()
  for (const y of [compactBox.y - 2, compactBox.y + compactBox.height + 2]) {
    await hoverIntoCompact()
    await notch.mouse.move(cx, y)
    await expect(capsule).toHaveAttribute('data-mode', 'peek')
  }
  await notch.mouse.move(1, 1)
  await expect(capsule).toHaveAttribute('data-mode', 'peek')

  // Right click on compact: the thin pill, flush against the top edge of the screen.
  await hoverIntoCompact()
  await capsule.click({ button: 'right' })
  await expect(capsule).toHaveAttribute('data-mode', 'mini')
  await expect.poll(async () => (await capsuleWindow(app)).height).toBeLessThan(peek.height)
  expect((await capsuleWindow(app)).y).toBe(workAreaTop)
  await settle(notch)
  const pill = await capsule.boundingBox()
  expect(pill).not.toBeNull()
  expect(pill!.y).toBe(0)
  expect(pill!.height).toBeLessThanOrEqual(5)
  await notch.screenshot({ path: 'test-results/capsule-modes-mini-es.png' })

  // The pointer on the pill (and leaving it) keeps the pill.
  await notch.mouse.move(1, 40)
  await capsule.hover()
  await notch.waitForTimeout(300)
  await expect(capsule).toHaveAttribute('data-mode', 'mini')

  // Left click on the pill: compact, which sticks while the pointer stays at the top edge (y < 6, above
  // the capsule itself), then peek once the pointer has been on compact and leaves it.
  const x = await centreX()
  await capsule.click()
  await expect(capsule).toHaveAttribute('data-mode', 'compact')
  await notch.mouse.move(x + 1, 3)
  await notch.mouse.move(x + 2, 4)
  await staysCompact()
  await notch.mouse.move(x, 24)
  await expect(capsule).toHaveAttribute('data-mode', 'compact')
  await notch.mouse.move(1, 1)
  await expect(capsule).toHaveAttribute('data-mode', 'peek')

  // Hover again: compact; a left click opens the panel.
  await hoverIntoCompact()
  await capsule.click()
  await expect(capsule).toHaveAttribute('data-mode', 'expanded')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/capsule-modes-panel-es.png' })

  await app.close()
})

test('a pinned pill takes the panel from the shortcut and returns to the pill; it is not remembered after a restart', async () => {
  let { app, notch } = await launch()
  const capsule = notch.getByTestId('notch-capsule')
  await capsule.hover()
  await capsule.click({ button: 'right' })
  await expect(capsule).toHaveAttribute('data-mode', 'mini')
  await notch.mouse.move(1, 40)

  // The global shortcut and the tray toggle the panel over the pill; closing it goes back to the pill.
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'toggle' }))
  await expect(capsule).toHaveAttribute('data-mode', 'expanded')
  await notch.keyboard.press('Escape')
  await expect(capsule).toHaveAttribute('data-mode', 'mini')
  await app.close()

  ;({ app, notch } = await launch())
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'peek')
  await app.close()
})

test('hide from the panel removes the capsule without quitting', async () => {
  const { app, notch } = await launch()

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await notch.getByRole('button', { name: /hide|ocultar/i }).click()
  await expect.poll(async () => (await capsuleWindow(app)).visible).toBe(false)

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'toggle' }))
  await expect.poll(async () => (await capsuleWindow(app)).visible).toBe(true)

  await app.close()
})

test('the seven integration tiles fit the panel without cutting a label, in ES and EN', async () => {
  const { app, notch } = await launch()
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  for (const language of ['es', 'en'] as const) {
    await notch.evaluate(
      (value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }),
      language,
    )
    await expect
      .poll(() =>
        notch.evaluate(
          () => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang,
        ),
      )
      .toBe(language)
    const measureFit = () =>
      notch.evaluate(() => {
        interface El {
          querySelector(selector: string): El | null
          scrollWidth: number
          clientWidth: number
          parentElement: El | null
          getBoundingClientRect(): { left: number; right: number }
          dataset: Record<string, string | undefined>
        }
        const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<El> } }).document
        const tiles = Array.from(doc.querySelectorAll('[data-testid^="integration-"]:not([data-testid$="-badge"])'))
        const row = tiles[0]?.parentElement
        return {
          count: tiles.length,
          cut: tiles
            .filter((tile) => {
              const label = tile.querySelector('span')
              return !label || label.scrollWidth > label.clientWidth
            })
            .map((tile) => tile.dataset.testid),
          // Rects, not scrollWidth: sub-pixel tile widths round the row's scrollWidth up by 1 px.
          rowOverflows: row
            ? tiles.some((tile) => tile.getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5)
            : true,
        }
      })
    // Polled: the labels re-render with the language a frame after `lang` changes.
    await expect.poll(measureFit).toEqual({ count: 7, cut: [], rowOverflows: false })
    if (language === 'es') {
      await settle(notch)
      await notch.screenshot({ path: 'test-results/integration-row-7-es.png' })
    }
  }
  await app.close()
})

test('Control Center changes language live and persists it with the shortcut', async () => {
  let { app, notch } = await launch()

  const opened = app.waitForEvent('window')
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const controlCenter = await opened
  await expect(controlCenter.getByRole('heading', { level: 1 })).toBeVisible()

  await controlCenter.getByRole('radio', { name: 'Español' }).click()
  await expect(controlCenter.getByRole('button', { name: 'Atajo' })).toBeVisible()
  await expect.poll(() => notch.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe('es')

  const saved = await controlCenter.evaluate(() =>
    (globalThis as unknown as NotchWindow).notch.settings.update({ shortcut: 'Alt+Shift+F9' }),
  )
  expect(saved).toMatchObject({ ok: true, data: { shortcut: 'Alt+Shift+F9' } })
  await app.close()

  const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>
  expect(settings).toMatchObject({ language: 'es', shortcut: 'Alt+Shift+F9' })

  ;({ app, notch } = await launch())
  const runtime = await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.getRuntime())
  expect(runtime).toMatchObject({ ok: true, data: { shortcutRegistered: true } })
  await expect.poll(() => notch.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe('es')
  await app.close()
})

test('About page shows the local usage log, and quitting saves it', async () => {
  const { app, notch } = await launch()

  // The summary is for the Control Center only.
  const fromNotch = await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.usage.summary({ days: 14 }))
  expect(fromNotch).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

  const opened = app.waitForEvent('window')
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const cc = await opened
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  await cc.getByRole('radio', { name: 'English' }).click()
  await cc.getByRole('button', { name: 'About' }).click()

  const usage = cc.getByRole('region', { name: 'Usage (last 14 days)' })
  await expect(usage).toBeVisible()
  // This launch is already counted.
  await expect(usage.getByRole('definition').nth(2)).toHaveText('1')
  await expect(usage.getByText('Stored only on this PC.')).toBeVisible()
  await usage.getByRole('radio', { name: '7 days' }).click()
  await expect(cc.getByRole('region', { name: 'Usage (last 7 days)' })).toBeVisible()
  await cc.screenshot({ path: 'test-results/polish-about-usage.png' })

  await app.close()
  const saved = JSON.parse(readFileSync(join(userData, 'usage.json'), 'utf8')) as { version: number; days: Record<string, { launches: number }> }
  expect(saved.version).toBe(1)
  expect(Object.values(saved.days).reduce((sum, day) => sum + day.launches, 0)).toBe(1)
})

test('quits cleanly after a minute idle, once the usage log has nothing left to save', async () => {
  // Real time on purpose: the 60 s usage tick saves the log, so the quit-time flush settles at once.
  // That used to swallow the second app.quit() and the app never exited (tray "Salir" included).
  test.slow()
  const { app } = await launch()
  const mainPid = await app.evaluate(() => process.pid)

  await expect
    .poll(() => {
      try {
        const saved = JSON.parse(readFileSync(join(userData, 'usage.json'), 'utf8')) as { days: Record<string, { runningMinutes: number }> }
        return Object.values(saved.days).reduce((sum, day) => sum + day.runningMinutes, 0)
      } catch {
        return 0
      }
    }, { timeout: 75_000, intervals: [1_000] })
    .toBeGreaterThanOrEqual(1)
  // Give the tick's write time to finish so nothing is pending at quit.
  await new Promise((resolve) => setTimeout(resolve, 2_000))

  const closed = await Promise.race([
    app.close().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
  ])
  if (!closed) process.kill(mainPid) // Only the Electron this test launched; keeps a failure from leaking it.
  expect(closed).toBe(true)
})
