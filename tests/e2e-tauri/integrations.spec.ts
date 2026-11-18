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
import {
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
const activeSwitch = (key: string) => $(`${row(key)} [role="switch"]`)

/** Opens the Control Center on «Integraciones» and switches WebDriver to it. */
async function openIntegrationsPage(): Promise<void> {
  await openControlCenter('integrations')
  await $('[data-testid="integrations-table"]').waitForDisplayed()
}

/** Turns an integration off from the table and waits for settings.json to say so. */
async function turnOff(key: string): Promise<void> {
  await activeSwitch(key).click()
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
    await eventually(tileCount, (n) => n === 9, 'nine tiles')
    await expect($('[data-testid="integration-gmail"]')).toBeDisplayed()

    await openIntegrationsPage()
    await turnOff('gmail')
    // The capsule switch of a switched-off integration is disabled.
    await expect($(`${row('gmail')} [role="switch"]:disabled`)).toExist()

    await useWindow('notch')
    await eventually(tileCount, (n) => n === 8, 'eight tiles')
    await expect($('[data-testid="integration-gmail"]')).not.toExist()
    expect(readIntegrations()['gmail']).toMatchObject({ enabled: false })

    await launch({ fresh: false })
    expect(readIntegrations()['gmail']).toMatchObject({ enabled: false })
    await requestIntent('expand')
    await eventually(tileCount, (n) => n === 8, 'eight tiles after a restart')
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
    const trigger = () => $(`${row('github')} button=Cambiar color`)
    await expect(trigger()).toBeFocused()

    await browser.keys(['Enter'])
    await $('[role="radiogroup"]').waitForDisplayed()
    await browser.keys(['ArrowRight', 'ArrowRight'])
    await eventually(async () => readIntegrations()['github']?.color, (color) => color === 'teal', 'github saved as teal')

    await browser.keys(['Escape'])
    await expect($('[role="radiogroup"]')).not.toExist()
    await expect(trigger()).toBeFocused()
  })

  it('disabling an integration with its view open returns home', async () => {
    await launch({ fresh: true, files: seeded })
    await requestIntent('expand')
    await $('[data-testid="integration-notes"]').click()
    await $('[data-testid="notes-panel"]').waitForDisplayed()
    await expect(capsule()).toHaveAttribute('data-mode', 'notes')

    await openIntegrationsPage()
    await turnOff('notes')

    await useWindow('notch')
    await eventually(async () => capsule().getAttribute('data-mode'), (mode) => mode === 'expanded', 'the notch back on home')
    await expect($('[data-testid="notes-panel"]')).not.toExist()
    await expect($('[data-testid="integration-notes"]')).not.toExist()
  })

  it('claude off passes permissions through', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()
    await openIntegrationsPage()
    await turnOff('claude')
    await useWindow('notch')

    const reply = postHook(bridge.hook, hookEvent('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }))
    // Immediate and empty: Claude Code asks in its own interface; the notch holds nothing.
    expect(await settledWithin(reply, 2000)).toEqual({ status: 200, body: '' })
    await expect(capsule()).not.toHaveAttribute('data-mode', 'permission')
  })
})
