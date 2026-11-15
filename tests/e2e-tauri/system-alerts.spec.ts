/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The RAM alert on the capsule metric and its threshold in the Control Center, ported from
// tests/e2e/system-alerts.spec.ts (Electron).
import { freemem, totalmem } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { eventually, fillValue, launch, openControlCenter, pointer, quitApp, seededSettings, setLanguage, settle, useWindow } from './helpers'

/** Current-version settings (`seededSettings`): RAM alert at 50 % (always firing on a dev machine); the other alerts off. */
const SETTINGS = seededSettings({
  cpu: { enabled: false, percent: 90, sustainSeconds: 30 },
  ram: { enabled: true, percent: 50 },
  battery: { enabled: false, percent: 15 },
  disk: { enabled: false, freePercent: 10 },
})

const THRESHOLD = 'input[aria-label="Umbral de RAM en %"], input[aria-label="RAM threshold in %"]'

describe('System alerts (Tauri)', () => {
  after(async () => {
    await quitApp()
  })

  it('the RAM metric alerts against a 50 % threshold and recovers when it is raised to 99 %', async function () {
    // 50 % is the lowest threshold the settings allow: with less RAM in use there is nothing to alert on.
    const usedAtStart = (1 - freemem() / totalmem()) * 100
    if (usedAtStart < 52) {
      console.log(`skipped: RAM in use is ${usedAtStart.toFixed(1)} % (< 52 %): the 50 % threshold cannot be crossed`)
      this.skip()
    }
    await launch({ fresh: true, files: { 'settings.json': SETTINGS } })
    // The capsule rests in peek (time and date): the metrics show in compact, with the pointer on it.
    await pointer(true)
    await expect($('[data-testid="notch-capsule"]')).toHaveAttribute('data-mode', 'compact')
    const ram = () => $('[data-testid="metric-ram"]')
    await ram().waitForDisplayed({ timeout: 10_000 })
    await expect(ram()).toHaveAttribute('data-alert', 'true', { wait: 5000 })
    await expect(ram()).toHaveElementClass(expect.stringContaining('text-fail'))
    expect(await $('[data-testid="metric-cpu"]').getAttribute('data-alert')).toBeNull()

    await settle()
    await setLanguage('en')
    await expect(ram()).toHaveAttribute('aria-label', expect.stringMatching(/^RAM /))
    await expect(ram()).toHaveAttribute('data-alert', 'true')
    await settle()

    await openControlCenter()
    await $('//nav//button[normalize-space()="Sistema" or normalize-space()="System"]').click()
    await $('[data-testid="system-alerts-page"]').waitForDisplayed()
    const threshold = () => $(THRESHOLD)
    await expect(threshold()).toHaveValue('50')
    await settle()

    const usedPercent = (1 - freemem() / totalmem()) * 100
    await threshold().click()
    await fillValue(THRESHOLD, '99')
    await browser.keys('Enter')
    await expect(threshold()).toHaveValue('99')
    if (usedPercent >= 94) {
      console.log(
        `note: RAM in use is ${usedPercent.toFixed(1)} % (>= 94 %, inside the 5-point hysteresis of 99): the recovery assertion did not run`,
      )
      return
    }
    // Back on the capsule (Electron's locator still points at the notch page).
    await useWindow('notch')
    await eventually(() => ram().getAttribute('data-alert'), (alert) => alert === null, 'the RAM alert to clear', 5000)
    expect(await ram().getAttribute('class')).not.toContain('text-fail')
  })
})
