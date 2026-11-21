/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The system monitor: the capsule metrics and the same figures in the panel's header, ported from
// 0.1.0's Electron e2e system.spec.ts. There is no System view any more (removed 2026-11-19): the
// header metrics are plain figures. Hover is `pointer()` (`__e2e:pointer`), as in app.spec.ts.
import { availableParallelism } from 'node:os'
import { $, $$, expect } from '@wdio/globals'
import { e2e, launch, pointer, quitApp, requestIntent, setLanguage, settle } from './helpers'

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

describe('System (Tauri)', () => {
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

  it('the panel header shows the same metrics as plain figures that open nothing', async () => {
    await launch({ fresh: true })
    await requestIntent('expand')
    await expectMode('expanded')
    const header = () => $('[data-testid="panel-system"]')
    await header().waitForDisplayed({ timeout: 10_000 })
    await expect($('[data-testid="panel-system"] [data-testid="metric-cpu"]')).toBeDisplayed()
    await expect($('[data-testid="panel-system"] [data-testid="metric-ram"]')).toBeDisplayed()
    // Not a button: no role, no title, out of the Tab order, and a click keeps the panel.
    expect(await header().getTagName()).toBe('span')
    expect(await header().getAttribute('title')).toBeNull()
    expect(await header().getAttribute('tabindex')).toBeNull()
    await header().click()
    await settle()
    await expectMode('expanded')
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
})
