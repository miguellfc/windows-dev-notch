/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The Control Center's Claude Code page lists every account with its own link switch, and the
// Work log page asks for an account until one is linked and chosen.
//
// GAP: the accounts come from a temp "home" (`NOTCH_CLAUDE_HOME`, a dev-only switch) holding
// `.claude-work` with a profile (`.claude.json`), so the spec never reads or writes the user's real
// `~/.claude*`. «Otra carpeta…» is a text field with an «Examinar…» button (the native folder
// browser is modal, so `NOTCH_CLAUDE_ACCOUNT_DIR`, a dev-only switch, answers a folder in its place;
// the dialog itself is never opened).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { ccAccountSwitch, ccConfirmInstall, ccDiff, eventually, launchClaude, openClaudePage, quitApp } from './helpers'

const EMAIL = 'ana.e2e@example.test'
const ORGANIZATION = 'Acme E2E'

let home: string | undefined
let picked: string | undefined

const textOf = (testId: string) => $(`[data-testid="${testId}"]`).getText()

describe('Control Center: Claude accounts and work log (Tauri)', () => {
  after(async () => {
    await quitApp()
    if (home) rmSync(home, { recursive: true, force: true })
    if (picked) rmSync(picked, { recursive: true, force: true })
  })

  it('lists the accounts, links claude-work with its diff, and the work log asks for an account', async () => {
    home = mkdtempSync(join(tmpdir(), 'notch-e2e-home-'))
    const work = join(home, '.claude-work')
    mkdirSync(work)
    writeFileSync(
      join(home, '.claude-work', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL, organizationName: ORGANIZATION } }),
    )
    picked = mkdtempSync(join(tmpdir(), 'notch-e2e-picked-'))
    await launchClaude({ env: { NOTCH_CLAUDE_HOME: home, NOTCH_CLAUDE_ACCOUNT_DIR: picked } })
    await openClaudePage()

    // Both accounts, the default first; the work one shows its profile and folder.
    await $('[data-testid="claude-account-claude"]').waitForDisplayed()
    await $('[data-testid="claude-account-claude-work"]').waitForDisplayed()
    const row = await textOf('claude-account-claude-work')
    expect(row).toContain(EMAIL)
    expect(row).toContain(`${ORGANIZATION} · ~/.claude-work`)
    expect(await textOf('claude-account-status-claude-work')).toMatch(/Hooks sin instalar|Hooks not installed/)

    // Linking shows the diff first (with the account header) and writes only after confirming.
    await ccAccountSwitch('~/.claude-work').click()
    await ccDiff().waitForDisplayed()
    await expect(ccDiff()).toHaveText(expect.stringContaining('x-notch-account'))
    expect(() => readFileSync(join(work, 'settings.json'), 'utf8')).toThrow()
    await ccConfirmInstall().click()
    await eventually(
      () => textOf('claude-account-status-claude-work'),
      (text) => /^(Hooks instalados|Hooks installed)$/.test(text),
      'claude-work showing its hooks installed',
    )
    expect(readFileSync(join(work, 'settings.json'), 'utf8')).toContain('x-notch-account')

    // «Examinar…» next to the path field fills it with the chosen folder and adds nothing yet.
    const browse = $('//button[normalize-space()="Examinar…" or normalize-space()="Browse…"]')
    await browse.waitForDisplayed()
    const field = $('input[aria-label="Ruta de la carpeta de Claude Code"], input[aria-label="Claude Code folder path"]')
    await browse.click()
    await browser.waitUntil(async () => (await field.getValue()) === picked, { timeoutMsg: 'the field to show the chosen folder' })
    const add = $('//button[normalize-space()="Añadir" or normalize-space()="Add"]')
    expect(await add.isEnabled()).toBe(true)
    await add.click()
    await $('//*[@role="status"][contains(., "Cuenta añadida") or contains(., "Account added")]').waitForDisplayed()
    expect(await field.getValue()).toBe('')

    // The work log page: no account chosen yet.
    await $('//nav//button[normalize-space()="Registro de trabajo" or normalize-space()="Work log"]').click()
    await $('[data-testid="work-log-choose-account"]').waitForDisplayed()
    expect(await textOf('work-log-choose-account')).toMatch(/Elige una cuenta|Choose an account/)
    // Claude is not on the PATH of the e2e run (NOTCH_WORKLOG_CLAUDE points nowhere).
    await browser.waitUntil(async () => (await $('[data-testid="work-log-claude-available"]').getAttribute('data-found')) === 'false', {
      timeoutMsg: 'the claude availability to settle',
    })
  })
})
