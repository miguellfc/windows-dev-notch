/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The work log end to end: a Claude Code session POSTed to the bridge (installed through the
// Control Center, as in claude.spec.ts) with its account header, measured by main while it runs
// (the capsule block), summarized at SessionEnd by a fake `claude -p` (NOTCH_WORKLOG_CLAUDE ->
// fixtures/fake-claude-summary.cmd, a fixed answer) and shown in the notch's list and detail; Copiar
// puts the Redmine text on the clipboard (the user's clipboard is put back afterwards).
//
// GAP: the account is a folder of this run's temp area added as an extra Claude folder (its id is
// `dir-` and 8 hex digits of its path's SHA-256, as main computes it), not `~/.claude-work`: the
// summary needs the account's folder to exist, and the spec never touches the user's home.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $, $$, expect } from '@wdio/globals'
import { compactWidthFor } from '../../src/shared/notch/geometry'
import {
  advanceClock,
  capsuleBox,
  clickCard,
  DEFAULT_ALERTS,
  e2e,
  eventually,
  hookEvent,
  inPage,
  installClaudeHooks,
  launchClaude,
  pointer,
  postHook,
  present,
  quitApp,
  requestIntent,
  seededSettings,
  settle,
  type ClaudeBridge,
} from './helpers'

const FAKE_CLAUDE = resolve('tests/e2e-tauri/fixtures/fake-claude-summary.cmd')
const SESSION = 'e2e-work-log-1'
const TITLE = 'Integrar la pasarela de pagos en ms-pay'
const DONE = 'Analizar la API de pagos'
const PENDING = 'Validar la firma del webhook'

const capsule = () => $('[data-testid="notch-capsule"]')
const mode = () => capsule().getAttribute('data-mode')
const expectMode = (value: string) => eventually(mode, (current) => current === value, `data-mode=${value}`)

/** The visible text of the first match, whitespace collapsed; null when absent. */
const textOf = (selector: string): Promise<string | null> =>
  inPage((sel: string) => {
    const el = (globalThis as unknown as { document: { querySelector(s: string): { innerText: string } | null } }).document.querySelector(sel)
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
  }, selector)

/** The id main gives an extra Claude folder outside `~/.claude*`: `dir-` and 8 hex digits of the SHA-256 of its lowercase path. */
const accountIdOf = (dir: string): string =>
  `dir-${createHash('sha256').update(dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()).digest('hex').slice(0, 8)}`

/** The capsule fits the view once the morph settles: the view's own height plus the 2 px border, its last line inside. */
async function expectCapsuleFitsView(): Promise<void> {
  await settle()
  const measure = () =>
    inPage(() => {
      const doc = (globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { height: number; bottom: number } } | null } }).document
      const panel = doc.querySelector('[data-testid="work-log-panel"]')?.getBoundingClientRect()
      const capsule = doc.querySelector('[data-testid="notch-capsule"]')?.getBoundingClientRect()
      return { view: Math.ceil(panel?.height ?? 0), capsule: capsule?.height ?? 0, inside: panel !== undefined && capsule !== undefined && panel.bottom <= capsule.bottom + 0.5 }
    })
  // A late reflow (the pixel font arriving) moves the view once more: wait for the capsule to follow.
  const fit = await eventually(measure, ({ view, capsule }) => Math.abs(capsule - (view + 2)) <= 1, 'the capsule fitting the view')
  expect(Math.abs((await capsuleBox()).height - (fit.view + 2))).toBeLessThanOrEqual(1)
  expect(fit.inside).toBe(true)
}

let accountDir: string | undefined
let savedClipboard: string | null | undefined

describe('Work log (Tauri)', () => {
  after(async () => {
    if (typeof savedClipboard === 'string') await e2e('clipboard', { text: savedClipboard }).catch(() => undefined)
    await quitApp()
    if (accountDir) rmSync(accountDir, { recursive: true, force: true })
  })

  it('measures a session, shows it in the capsule, summarizes it and copies it', async () => {
    accountDir = mkdtempSync(join(tmpdir(), 'notch-e2e-account-'))
    const account = accountIdOf(accountDir)
    const base = seededSettings(DEFAULT_ALERTS)
    await launchClaude({
      env: { NOTCH_WORKLOG_CLAUDE: FAKE_CLAUDE },
      files: {
        'settings.json': {
          ...base,
          workLog: { accountId: account, idlePauseMinutes: 30 },
          integrations: { ...base.integrations, workLog: { ...base.integrations.workLog, enabled: true, capsule: true } },
          claudeAccounts: { ...base.claudeAccounts, extraDirs: [accountDir] },
        },
      },
    })
    savedClipboard = await e2e<string | null>('clipboard')
    const bridge: ClaudeBridge = await installClaudeHooks()
    const post = async (name: string, extra: Record<string, unknown> = {}) =>
      expect((await postHook(bridge.hook, hookEvent(SESSION, name, { cwd: 'C:\\work\\ms-pay', ...extra }), { 'x-notch-account': account })).status).toBe(200)

    await post('SessionStart', { source: 'startup' })
    await post('UserPromptSubmit', { prompt: 'Analiza la API de pagos', prompt_id: 'p-1' })

    // At rest, the peek shows it too: a play sign and the live total after the time and date.
    await expectMode('peek')
    await $(present('metric-work-log')).waitForDisplayed({ timeout: 15_000 })
    expect(await $(present('work-log-play')).isExisting()).toBe(true)

    // While it runs, the compact capsule shows its live total after Claude's mark.
    await pointer(true)
    await expectMode('compact')
    await $(present('metric-work-log')).waitForDisplayed({ timeout: 15_000 })
    expect(await $(present('metric-work-log')).getAttribute('data-status')).toBe('running')
    // Its reserved width is CAPSULE_BLOCK.workLog: the capsule is as wide as compactWidthFor says.
    await settle()
    const shown = async (id: string) => (await $$(present(id))).length > 0
    const system = (await shown('capsule-zone-system')) ? { battery: await shown('metric-battery') } : null
    const blocks = { claude: await shown('claude-dots'), mail: false, reviews: 0 as const, redmine: false, workLog: true }
    expect(Math.abs((await capsuleBox()).width - compactWidthFor({ system, blocks }))).toBeLessThanOrEqual(1)
    await pointer(false)

    // 25 minutes of Claude working, then the session ends: main summarizes it with the fake.
    await advanceClock(25 * 60_000)
    await post('Stop', { last_assistant_message: 'He analizado la API de pagos.', stop_hook_active: false })
    await post('SessionEnd', { reason: 'other' })

    await requestIntent('expand')
    await expectMode('expanded')
    await clickCard('integration-workLog')
    await expectMode('workLog')
    await $('[data-testid="work-log-list"]').waitForDisplayed()
    await eventually(() => textOf('[data-testid="work-log-entry-title"]'), (text) => text === TITLE, 'the summary title in the list', 20_000)
    await eventually(() => textOf('[data-testid="work-log-status"]'), (text) => text === 'sin imputar', 'the "sin imputar" pill')
    expect(await textOf('[data-testid="work-log-entry"]')).toContain('1 de 2 hechas')
    expect(await textOf('[data-testid="work-log-times"]')).toBe('Claude 25m · Total 25m')
    await expectCapsuleFitsView()

    await $('[data-testid="work-log-entry"]').click()
    await $('[data-testid="work-log-detail"]').waitForDisplayed()
    await expectCapsuleFitsView()
    expect(await textOf('[data-testid="work-log-detail-title"]')).toBe(TITLE)
    const subtasks = await $$('[data-testid="work-log-subtask"]')
    expect(subtasks.length).toBe(2)
    expect(await textOf('[data-testid="work-log-subtasks"]')).toContain(DONE)
    expect(await textOf('[data-testid="work-log-subtasks"]')).toContain(`${PENDING} pendiente`)
    expect(await textOf('[data-testid="work-log-total"]')).toBe('25m')

    await $('[data-testid="work-log-copy"]').click()
    const expected = [`Tarea: ${TITLE} (Claude 25m · Total 25m)`, 'Subtareas:', `1 - ${DONE} (Claude 25m · Total 25m)`, `2 - ${PENDING} (pendiente)`].join('\n')
    await eventually(() => e2e<string | null>('clipboard'), (text) => text === expected, 'the work log text on the clipboard')
    await eventually(() => textOf('[data-testid="work-log-copy"]'), (text) => text === 'Copiado', '"Copiado" on Copiar')

    // A subtask copies alone.
    await $$('[data-testid="work-log-subtask"]')[1]!.click()
    await eventually(() => e2e<string | null>('clipboard'), (text) => text === `${PENDING} (pendiente)`, 'the pending subtask on the clipboard')
    await $('[data-testid="work-log-subtask-copied"]').waitForDisplayed()
  })
})
