/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Configurable integrations (0.3.0): the Control Center «Integraciones» page turns each integration
// on or off and picks its colour. Every test starts a fresh app in Spanish; settings.json is read
// back from the run's profile, and the notch is observed on its own window.
//
// GAP: the Gmail capsule block only exists with unread mail (a signed-in session), which the e2e
// cannot fake; its hiding is covered by unit tests (capsuleShows), here only the tile is checked.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { Key } from 'webdriverio'
import {
  clickCard,
  DEFAULT_ALERTS,
  dataDir,
  eventually,
  hookEvent,
  inPage,
  installClaudeHooks,
  launch,
  launchClaude,
  openControlCenter,
  postHook,
  quitApp,
  requestIntent,
  seededSettings,
  settle,
  settledWithin,
  useWindow,
} from './helpers'

interface IntegrationBlock {
  enabled: boolean
  capsule: boolean
  color: string
}

const readIntegrations = (): Record<string, IntegrationBlock> =>
  (JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8')) as { integrations: Record<string, IntegrationBlock> }).integrations

const capsule = () => $('[data-testid="notch-capsule"]')
const TILES = '[data-testid^="integration-"]:not([data-testid$="-badge"]):not([data-testid$="-label"])'
const tileCount = async () => (await $$(TILES)).length
const row = (key: string) => `[data-testid="integration-row-${key}"]`
// The row's first switch is «Activa» (the second, when present, is «Cápsula»).
const activeSwitch = async (key: string) => (await $$(`${row(key)} [role="switch"]`))[0]!

/** Opens the Control Center on «Integraciones» and switches WebDriver to it. */
async function openIntegrationsPage(): Promise<void> {
  await openControlCenter()
  await $('//nav//button[normalize-space()="Integraciones" or normalize-space()="Integrations"]').click()
  await $('[data-testid="integrations-table"]').waitForDisplayed()
}

/** Turns an integration off from the table and waits for settings.json to say so. */
async function turnOff(key: string): Promise<void> {
  await (await activeSwitch(key)).click()
  await eventually(async () => readIntegrations()[key]?.enabled, (enabled) => enabled === false, `${key} saved as off`)
}

const seeded = { 'settings.json': seededSettings(DEFAULT_ALERTS) }

describe('Integrations (Tauri)', () => {
  after(async () => {
    await quitApp()
  })

  it('turning Gmail off hides its tile and capsule block and persists', async () => {
    await launch({ fresh: true, files: seeded })
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
    await eventually(tileCount, (n) => n === 8, 'eight tiles')
    await expect($('[data-testid="integration-gmail"]')).toBeDisplayed()

    await openIntegrationsPage()
    // Seven rows: System has no row since its view was removed (its metrics need no switch).
    expect((await $$('[data-testid^="integration-row-"]')).length).toBe(7)
    await expect($(row('system'))).not.toExist()
    await turnOff('gmail')
    // The capsule switch of a switched-off integration is disabled.
    await expect($(`${row('gmail')} [role="switch"]:disabled`)).toExist()

    await useWindow('notch')
    await requestIntent('expand')
    await eventually(tileCount, (n) => n === 7, 'seven tiles')
    await expect($('[data-testid="integration-gmail"]')).not.toExist()
    expect(readIntegrations()['gmail']).toMatchObject({ enabled: false })

    await launch({ fresh: false })
    expect(readIntegrations()['gmail']).toMatchObject({ enabled: false })
    await requestIntent('expand')
    await eventually(tileCount, (n) => n === 7, 'seven tiles after a restart')
    await expect($('[data-testid="integration-gmail"]')).not.toExist()
  })

  it('color picker by keyboard', async () => {
    await launch({ fresh: true, files: seeded })
    await openIntegrationsPage()
    // GitHub starts on green; the palette continues emerald, teal.
    expect(readIntegrations()['github']?.color).toBe('green')

    // Tab from the row's last switch lands on «Cambiar color».
    await inPage(() =>
      (
        globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ focus(): void }> } }
      ).document.querySelectorAll('[data-testid="integration-row-github"] [role="switch"]')[1]?.focus(),
    )
    await browser.keys(['Tab'])
    const trigger = () => $('//*[@data-testid="integration-row-github"]//button[normalize-space()="Cambiar color"]')
    await expect(trigger()).toBeFocused()

    const popup = () => $('[role="dialog"]')
    // Hue is the first of the three sliders.
    const hue = () => $('(//*[@role="dialog"]//input[@type="range"])[1]')
    const code = () => $('//*[@role="dialog"]//label[normalize-space()="Código"]/following-sibling::input')
    const save = () => $('//*[@role="dialog"]//button[normalize-space()="Guardar"]')

    // Opening focuses Hue and names the dialog after the integration; the button points at it.
    await browser.keys(['Enter'])
    await popup().waitForDisplayed()
    const titleId = await popup().getAttribute('aria-labelledby')
    await expect($(`[id="${titleId}"]`)).toHaveText('Color de GitHub')
    await expect(hue()).toBeFocused()
    const dialogId = await popup().getAttribute('id')
    expect(dialogId).toBeTruthy()
    await expect(trigger()).toHaveAttribute('aria-controls', dialogId!)

    // Tab past the sliders and the code field to the shortcuts: one stop, on the current colour.
    for (let i = 0; i < 6; i++) {
      const role = await inPage(
        () => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute('role') ?? null,
      )
      if (role === 'radio') break
      await browser.keys(['Tab'])
    }
    await expect($('//*[@role="radiogroup"]//*[@role="radio" and @aria-label="Verde"]')).toBeFocused()
    await browser.keys(['ArrowRight'])
    const emerald = () => $('//*[@role="radiogroup"]//*[@role="radio" and @aria-label="Esmeralda"]')
    await expect(emerald()).toBeFocused()
    await browser.keys(['Enter'])
    await expect(emerald()).toHaveAttribute('aria-checked', 'true')
    // Nothing is saved before Guardar.
    expect(readIntegrations()['github']?.color).toBe('green')
    await save().click()
    await expect(popup()).not.toExist()
    await eventually(async () => readIntegrations()['github']?.color, (color) => color === 'emerald', 'github saved as emerald')
    await expect(trigger()).toBeFocused()

    // A custom colour typed in the code field is stored as uppercase hex.
    await browser.keys(['Enter'])
    await popup().waitForDisplayed()
    await code().click()
    await browser.action('key').down(Key.Ctrl).down('a').up('a').up(Key.Ctrl).perform()
    // Any case, with or without #: the field normalizes it.
    await code().addValue('#a3b18a')
    await save().click()
    await expect(popup()).not.toExist()
    await eventually(async () => readIntegrations()['github']?.color, (color) => color === '#A3B18A', 'github saved as #A3B18A')

    // Esc discards the draft and returns focus to the button.
    await trigger().click()
    await popup().waitForDisplayed()
    await expect(hue()).toBeFocused()
    await browser.keys(['ArrowRight', 'ArrowRight'])
    await browser.keys(['Escape'])
    await expect(popup()).not.toExist()
    await expect(trigger()).toBeFocused()
    expect(readIntegrations()['github']?.color).toBe('#A3B18A')
  })

  it('disabling an integration with its view open returns home', async () => {
    await launch({ fresh: true, files: seeded })
    await requestIntent('expand')
    await clickCard('integration-notes')
    await $('[data-testid="notes-panel"]').waitForDisplayed()
    await expect(capsule()).toHaveAttribute('data-mode', 'notes')

    await openIntegrationsPage()
    await turnOff('notes')

    await useWindow('notch')
    // The view closes (Back sends the panel home). With the notch's focus lost to the Control Center
    // it then rests as a capsule: compact with the real cursor over it, peek with the cursor away.
    await eventually(async () => capsule().getAttribute('data-mode'), (mode) => mode === 'compact' || mode === 'peek', 'the notes view closed to a resting capsule')
    await expect($('[data-testid="notes-panel"]')).not.toExist()
    // Expanding again shows home (the tiles), not the view.
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
    await expect($('[data-testid="integration-notes"]')).not.toExist()
  })

  it('claude off hides its sessions and passes permissions through', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()
    // A session first (as in claude.spec): with Claude on, the home panel lists it.
    expect((await postHook(bridge.hook, hookEvent('api-server', 'UserPromptSubmit'))).status).toBe(200)
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
    await $('[data-testid="claude-sessions"]').waitForDisplayed()

    await openIntegrationsPage()
    await turnOff('claude')
    await useWindow('notch')

    // With Claude off the home panel lists no sessions (and the tile is gone).
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
    await eventually(tileCount, (n) => n === 7, 'seven tiles')
    await expect($('[data-testid="claude-sessions"]')).not.toExist()

    const permission = (command: string) =>
      postHook(bridge.hook, hookEvent('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command } }))
    // Immediate and empty: Claude Code asks in its own interface; the notch holds nothing.
    expect(await settledWithin(permission('npm run build'), 2000)).toEqual({ status: 200, body: '' })
    // Nothing was retained: a second request is answered just as fast, and nothing raises the permission card.
    expect(await settledWithin(permission('npm test'), 2000)).toEqual({ status: 200, body: '' })
    await browser.pause(500)
    await settle()
    const mode = await capsule().getAttribute('data-mode')
    expect(mode).not.toBe('permission')
    expect(mode).not.toBe('alert')
  })
})
