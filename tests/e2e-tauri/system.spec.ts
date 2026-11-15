/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The system monitor (capsule metrics, System view, process list), ported from
// tests/e2e/system.spec.ts (Electron). Hover is `pointer()` (`__e2e:pointer`), as in app.spec.ts.
import { spawn, type ChildProcess } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { $, $$, browser, expect } from '@wdio/globals'
import { CONFIRM_ARM_MS } from '../../src/renderer/notch/system/confirm-guard'
import { PROCESS_LIMIT } from '../../src/shared/system/schema'
import { cssOf, e2e, eventually, inPage, isAlive, launch, pointer, pointerToCorner, quitApp, requestIntent, setLanguage, settle } from './helpers'

let burner: ChildProcess | undefined

/** The first process row (Playwright's `.first()`; WebdriverIO's `$` refuses several matches). */
const FIRST_ROW = '(//*[@data-testid="process-row"])[1]'

const capsule = () => $('[data-testid="notch-capsule"]')
const expectMode = (value: string) => expect(capsule()).toHaveAttribute('data-mode', value)

/** The capsule as if the pointer were on it (compact: metrics, mail, reviews, Claude dots). */
async function showCompact(): Promise<void> {
  await pointer(true)
  await expectMode('compact')
}

/** The pointer leaves the capsule: back to peek, the resting capsule (time and date). */
async function leaveCapsule(): Promise<void> {
  await pointer(false)
  await expectMode('peek')
}

async function openSystem(): Promise<void> {
  await requestIntent('expand')
  await expectMode('expanded')
  const tile = $('[data-testid="integration-system"]')
  await expect(tile).toHaveText(/^(Sistema|System)$/)
  await tile.click()
  await expectMode('system')
}

/** A child of this test that spins one core. */
const spawnBurner = (): ChildProcess => {
  const child = spawn('node', ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true })
  burner = child
  return child
}

/** A bare DOM click (Playwright's `dispatchEvent('click')`): no pointer move, no timing. */
const dispatchClick = (selector: string): Promise<void> =>
  inPage((sel: string) => {
    const w = globalThis as unknown as {
      document: { querySelector(s: string): { dispatchEvent(event: unknown): boolean } | null }
      MouseEvent: new (type: string, init: Record<string, unknown>) => unknown
    }
    const el = w.document.querySelector(sel)
    if (!el) throw new Error(`No element ${sel}`)
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))
  }, selector)

/** Whether the element matching `selector` is the page's focused element. */
const focused = (selector: string): Promise<boolean> =>
  inPage((sel: string) => {
    const doc = (globalThis as unknown as { document: { querySelector(s: string): unknown; activeElement: unknown } }).document
    const el = doc.querySelector(sel)
    return el !== null && el === doc.activeElement
  }, selector)

const opacity = (selector: string, value: string, what: string) =>
  eventually(() => cssOf(selector, 'opacity'), (current) => current === value, what)

describe('System (Tauri)', () => {
  afterEach(() => {
    // Only the process this test spawned is ever killed.
    if (burner?.pid !== undefined && isAlive(burner.pid)) burner.kill()
    burner = undefined
  })

  after(async () => {
    await quitApp()
  })

  it('the capsule shows CPU and RAM, in both languages', async () => {
    await launch({ fresh: true })
    // The capsule rests in peek (time and date): the metrics show in compact, with the pointer on it.
    await showCompact()
    await $('[data-testid="capsule-metrics"]').waitForDisplayed({ timeout: 10_000 })
    await expect($('[data-testid="metric-cpu"]')).toBeDisplayed()
    await expect($('[data-testid="metric-ram"]')).toBeDisplayed()
    // Battery only exists on laptops.
    console.log(`battery metric present: ${(await $$('[data-testid="metric-battery"]').length) > 0}`)

    await setLanguage('es')
    await expect($('[data-testid="metric-cpu"]')).toHaveAttribute('aria-label', expect.stringMatching(/^CPU /))
    await settle()

    await setLanguage('en')
    await expect($('[data-testid="metric-ram"]')).toHaveAttribute('aria-label', expect.stringMatching(/^RAM /))
    await settle()
  })

  it('the System tile shows cards and processes in under 2 s', async () => {
    await launch({ fresh: true })
    await setLanguage('es')
    await requestIntent('expand')
    await expectMode('expanded')
    const tile = $('[data-testid="integration-system"]')
    await expect(tile).toHaveText('Sistema')
    await tile.click()
    await expectMode('system')
    await $('[data-testid="system-card-cpu"]').waitForDisplayed({ timeout: 2000 })
    await $('[data-testid="system-card-ram"]').waitForDisplayed({ timeout: 2000 })
    await $(FIRST_ROW).waitForDisplayed({ timeout: 2000 })
    // The list is the top 5 (PROCESS_LIMIT): never more rows, and the panel (280 px) shows them without scrolling.
    await eventually(() => $$('[data-testid="process-row"]').length, (count) => count === PROCESS_LIMIT, `${PROCESS_LIMIT} process rows`)
    const fits = await inPage(() => {
      const el = (
        globalThis as unknown as { document: { querySelector(s: string): { scrollHeight: number; clientHeight: number } | null } }
      ).document.querySelector('[data-testid="process-list"]')
      return el !== null && el.scrollHeight <= el.clientHeight
    })
    expect(fits).toBe(true)
    // Main warms up before the first emission: the very first list already has CPU values, and the
    // network card has rates, instead of "—".
    // Read once (no auto-retry): the first emission itself must carry the values.
    expect(await $(FIRST_ROW).getText()).not.toContain('—')
    expect(await $('[data-testid="system-card-network"]').getText()).not.toContain('—')
    await settle()
  })

  it('closes a busy process through the UI; a non-killable row (when listed) has no Close button', async () => {
    const child = spawnBurner()
    const pid = child.pid
    if (pid === undefined) throw new Error('could not spawn the busy process')
    await launch({ fresh: true })
    await openSystem()

    const rowSelector = `[data-testid="process-row"][data-pid="${pid}"]`
    const row = () => $(rowSelector)
    const close = () => $(`${rowSelector} [data-testid="process-close"]`)
    // The first CPU reading after opening is null; the second tick ranks the process (it must reach the top 5 by CPU).
    await row().waitForDisplayed({ timeout: 10_000 })

    const rows = await inPage(() =>
      Array.from(
        (
          globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ querySelector(s: string): unknown }> } }
        ).document.querySelectorAll('[data-testid="process-row"]'),
      ).map((el) => el.querySelector('[data-testid="process-close"]') !== null),
    )
    expect(rows.length).toBeLessThanOrEqual(PROCESS_LIMIT)
    if (rows.includes(false)) {
      // The first row without a Close button (read in one go, so it cannot move in between).
      expect(rows.filter((killable) => !killable).length).toBeGreaterThan(0)
    } else {
      console.log(`note: no non-killable row among the ${rows.length} listed processes; the no-Close-button assertion did not run`)
    }

    await row().moveTo()
    await close().click()
    const confirm = () => $('[data-testid="process-confirm"]')
    await expect(confirm()).toBeDisplayed()
    await expect(confirm()).toHaveText(expect.stringContaining(String(pid)))
    await settle()

    // Esc cancels the question and keeps the view.
    await browser.keys('Escape')
    await confirm().waitForDisplayed({ reverse: true })
    await expectMode('system')
    expect(isAlive(pid)).toBe(true)

    // A double-click on Close must not terminate. By design the confirm row puts Cancel under the
    // same spot as the ✕, so the second click of the pair cancels the question.
    await row().moveTo()
    await close().doubleClick()
    await confirm().waitForDisplayed({ reverse: true })
    expect(isAlive(pid)).toBe(true)
    await expectMode('system')

    // The 300 ms guard itself: activating the confirm button right after the question opens is ignored.
    await row().moveTo()
    await close().click()
    await expect(confirm()).toBeDisplayed()
    await dispatchClick('[data-testid="process-confirm-close"]')
    expect(isAlive(pid)).toBe(true)
    await expect(confirm()).toBeDisplayed()

    // This wait must stay above the renderer's CONFIRM_ARM_MS (300 ms) guard, or the click is ignored.
    await browser.pause(CONFIRM_ARM_MS + 100)
    await $('[data-testid="process-confirm-close"]').click()
    await eventually(async () => isAlive(pid), (alive) => !alive, `process ${pid} to end`, 5000)
    await eventually(() => $$(`[data-pid="${pid}"]`).length, (count) => count === 0, `the row of ${pid} to go`, 5000)
    await expectMode('system')
  })

  it('idle cost at rest (peek, still sampling light metrics) stays under 0.5 % CPU', async function () {
    this.timeout(150_000)
    await launch({ fresh: true })
    await expectMode('peek')
    // Peek keeps the light rhythm (so a hover shows current values at once): check it flows, then rest.
    await showCompact()
    await $('[data-testid="metric-cpu"]').waitForDisplayed({ timeout: 10_000 })
    await leaveCapsule()
    // `__e2e:process-cpu`: CPU time of the app's whole process tree (its WebView2 processes too),
    // the Tauri twin of summing Electron's `app.getAppMetrics()` percentages. Electron's
    // `percentCPUUsage` is a share of the whole machine (one busy core reads 100 / logical
    // processors: 6.25 % on 16), so each 5 s interval is turned into that same unit; the share of
    // one core is logged next to it.
    const cores = availableParallelism()
    type Cpu = { cpuMs: number; processes: number; perProcess: { pid: number; cpuMs: number }[] }
    const SAMPLES = 12
    const readings: number[] = []
    let previous = await e2e<Cpu>('process-cpu')
    let previousAt = Date.now()
    let afterWarmUp = previous
    for (let i = 0; i < SAMPLES; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      const current = await e2e<Cpu>('process-cpu')
      const now = Date.now()
      readings.push(((current.cpuMs - previous.cpuMs) / (now - previousAt)) * 100 / cores)
      if (i === 0) afterWarmUp = current
      previous = current
      previousAt = now
    }
    // The first sample is a warm-up (startup work, first metrics tick); it is discarded.
    const totals = readings.slice(1)
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length
    // Where the time went over the measured window, by pid (the app first, then its WebView2 tree).
    const byPid = previous.perProcess.map(({ pid, cpuMs }) => {
      const before = afterWarmUp.perProcess.find((entry) => entry.pid === pid)?.cpuMs ?? 0
      return `${pid}:${(cpuMs - before).toFixed(0)}ms`
    })
    console.log(
      `idle CPU (peek, ${SAMPLES} samples, first discarded, ${previous.processes} processes, ${cores} logical processors): mean ${mean.toFixed(3)} % of the machine (${(mean * cores).toFixed(2)} % of one core), samples ${totals.map((v) => v.toFixed(3)).join(' ')}; ms by pid ${byPid.join(' ')}`,
    )
    expect(mean).toBeLessThan(0.5)
  })

  it('a process row shows its Close button on hover or keyboard focus only', async () => {
    await launch({ fresh: true })
    await openSystem()
    // The first row that has a Close button.
    const firstKillable = '(//*[@data-testid="process-row"][.//*[@data-testid="process-close"]])[1]'
    await $(firstKillable).waitForDisplayed({ timeout: 10_000 })
    const pid = await $(firstKillable).getAttribute('data-pid')
    // Pinned to that row from here on (by pid), so a CPU re-rank cannot swap it mid-check.
    const row = () => $(`[data-testid="process-row"][data-pid="${pid}"]`)
    const closeOf = `[data-testid="process-row"][data-pid="${pid}"] [data-testid="process-close"]`

    await row().moveTo()
    await opacity(closeOf, '1', 'the Close button shown on hover')
    // Script focus after pointer use is not keyboard focus: it must not pin the button.
    await inPage((sel: string) => {
      const el = (globalThis as unknown as { document: { querySelector(s: string): { focus(): void } | null } }).document.querySelector(sel)
      el?.focus()
    }, closeOf)
    await pointerToCorner()
    await opacity(closeOf, '0', 'the Close button hidden once the pointer leaves')

    // Keyboard focus reveals it with no hover.
    await inPage((sel: string) => {
      const el = (globalThis as unknown as { document: { querySelector(s: string): { focus(): void } | null } }).document.querySelector(sel)
      el?.focus()
    }, closeOf)
    await browser.keys(['Shift', 'Tab'])
    await browser.keys('Tab')
    await eventually(() => focused(closeOf), (yes) => yes, 'the Close button focused')
    await opacity(closeOf, '1', 'the Close button shown on keyboard focus')
  })
})
