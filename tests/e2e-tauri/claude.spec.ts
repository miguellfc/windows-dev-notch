/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Claude Code permissions, sessions and hook install, ported from 0.1.0's
// Electron e2e claude.spec.ts. Each test starts a fresh app whose Claude settings.json is a file of this run's temp
// profile (`--e2e-env-NOTCH_CLAUDE_SETTINGS`, checked before anything runs) and whose bridge listens
// on an ephemeral port. The hooks are installed through the Control Center, like a user would; the
// spec reads URL and token back from that settings.json and POSTs the hooks with Node's `http`.
//
// Hover is `pointer()` (`__e2e:pointer`), as in app.spec.ts. GAP: the Electron spec also saves
// screenshots (test-results/m3-*.png); they are not assertions and are left out here, as in the
// other Tauri specs.
import { $, browser, expect } from '@wdio/globals'
import {
  ccConfirmInstall,
  ccConfirmUninstall,
  ccDiff,
  ccInstall,
  ccUninstall,
  claudeSettingsFile,
  eventually,
  expectPreviewOfTempFile,
  hookEvent,
  inPage,
  installClaudeHooks,
  launchClaude,
  openClaudePage,
  pointer,
  postHook,
  quitApp,
  readClaudeSettings,
  requestIntent,
  settledWithin,
  settle,
  type ClaudeBridge,
  type HookReply,
} from './helpers'

const ALLOW_BODY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY_BODY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'

const capsule = () => $('[data-testid="notch-capsule"]')
const mode = () => capsule().getAttribute('data-mode')
const byTestId = (id: string) => $(`[data-testid="${id}"]`)

const permissionRequest = (session: string, command = 'npm run build') =>
  hookEvent(session, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command } })

/** Sends a PermissionRequest and returns the held reply (boxed: returning the bare promise would await it) plus the POST→alert latency. */
async function holdPermission(bridge: ClaudeBridge, session: string, command?: string): Promise<{ reply: Promise<HookReply> }> {
  const startedAt = Date.now()
  const reply = postHook(bridge.hook, permissionRequest(session, command))
  await browser.waitUntil(async () => (await mode()) === 'alert', { timeout: 1000, interval: 20, timeoutMsg: 'no alert within 1 s' })
  const latency = Date.now() - startedAt
  console.log(`PermissionRequest -> alert after ${latency} ms`)
  expect(latency).toBeLessThan(1000)
  return { reply }
}

/** Buttons stay disabled for 600 ms after a request appears. */
async function settled(testId: string): Promise<void> {
  await byTestId(testId).waitForDisplayed()
  await byTestId(testId).waitForEnabled({ timeout: 3000 })
}

const notAlert = () => eventually(mode, (value) => value !== 'alert', 'the alert to clear')

describe('Claude Code (Tauri)', () => {
  beforeEach(() => {
    // Fail fast: Claude's settings.json must be a file of this run's temp profile.
    claudeSettingsFile()
  })

  after(async () => {
    await quitApp()
  })

  it('shows Claude sessions as dots (working then done) and in the panel', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()

    expect((await postHook(bridge.hook, hookEvent('api-server', 'UserPromptSubmit', { prompt: 'secret prompt' }))).status).toBe(200)
    // The resting peek shows Claude's mark after the time and date (no dots, no "+N").
    await expect(capsule()).toHaveAttribute('data-mode', 'peek')
    const dots = byTestId('claude-dots')
    await dots.waitForDisplayed()
    await expect(dots.$$('.status-dot')).toBeElementsArrayOfSize(0)
    // The compact capsule too: the mark alone; the label counts the sessions per state.
    await pointer(true)
    await expect(capsule()).toHaveAttribute('data-mode', 'compact')
    await dots.waitForDisplayed()
    await expect(dots).toHaveAttribute('aria-label', /Claude Code: 1 (trabajando|working)/)
    await expect(dots.$$('.status-dot')).toBeElementsArrayOfSize(0)

    await postHook(bridge.hook, hookEvent('web-client', 'UserPromptSubmit'))
    await eventually(() => dots.getAttribute('aria-label'), (label) => /2 (trabajando|working)/.test(label ?? ''), 'two working sessions')
    await postHook(bridge.hook, hookEvent('api-server', 'Stop', { last_assistant_message: 'done' }))
    await expect(dots).toHaveAttribute('aria-label', /Claude Code/)
    await eventually(() => dots.getAttribute('aria-label'), (label) => /(listo|done|terminad|finished)/i.test(label ?? ''), 'a done session')
    await settle()

    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
    const sessions = byTestId('claude-sessions')
    await sessions.waitForDisplayed()
    await expect(sessions).toHaveText(expect.stringContaining('api-server'))
    await expect(sessions).toHaveText(expect.stringContaining('web-client'))
  })

  it('a permission request raises the alert in under 1 s and Permitir answers allow', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()
    await postHook(bridge.hook, hookEvent('api-server', 'UserPromptSubmit'))

    const { reply } = await holdPermission(bridge, 'api-server', 'npm run build')
    const alert = byTestId('claude-alert')
    await expect(alert).toHaveText(expect.stringContaining('api-server'))
    await expect(alert).toHaveText(expect.stringContaining('Bash'))

    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'permission')
    await expect(byTestId('claude-permission')).toHaveText(expect.stringContaining('npm run build'))
    await settled('claude-allow')
    await byTestId('claude-allow').click()

    const answer = await reply
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(ALLOW_BODY)
    await byTestId('claude-permission').waitForDisplayed({ reverse: true })
  })

  it('Denegar answers deny', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()

    const { reply } = await holdPermission(bridge, 'api-server', 'rm -rf build')
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'permission')
    await settled('claude-deny')
    await byTestId('claude-deny').click()

    const answer = await reply
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(DENY_BODY)
  })

  it('a later PostToolUse of the same session releases the request with an empty 200 and clears the alert', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()

    const { reply } = await holdPermission(bridge, 'api-server')
    // Claude's own prompt was answered in the terminal: the tool ran.
    expect((await postHook(bridge.hook, hookEvent('api-server', 'PostToolUse', { tool_name: 'Bash' }))).status).toBe(200)

    expect(await reply).toEqual({ status: 200, body: '' })
    await byTestId('claude-alert').waitForDisplayed({ reverse: true })
    await notAlert()
  })

  it('a UserPromptSubmit of the session releases a held request (answered or interrupted in Claude)', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()

    expect((await postHook(bridge.hook, hookEvent('api-server', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-1' }))).status).toBe(200)
    const { reply } = await holdPermission(bridge, 'api-server')
    // A parallel call of the same session finishing does not release it...
    await postHook(bridge.hook, hookEvent('api-server', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-2' }))
    await postHook(bridge.hook, hookEvent('api-server', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu-2' }))
    expect(await settledWithin(reply, 500)).toBe('pending')
    // ...but the user moving on in Claude does.
    expect((await postHook(bridge.hook, hookEvent('api-server', 'UserPromptSubmit', { prompt: 'never mind' }))).status).toBe(200)

    expect(await reply).toEqual({ status: 200, body: '' })
    await byTestId('claude-alert').waitForDisplayed({ reverse: true })
    await notAlert()
  })

  it('Permitir stays disabled when the preview is truncated; Denegar still works', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()

    const { reply } = await holdPermission(bridge, 'api-server', `echo ${'x'.repeat(2_395)}`)
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'permission')
    const allow = byTestId('claude-allow')
    await settled('claude-deny')
    await expect(byTestId('claude-permission-truncated')).toHaveText(expect.stringContaining('400'))
    expect(await allow.isEnabled()).toBe(false)
    await expect(allow).toHaveAttribute('aria-description', /Claude/)
    // Still disabled well after the settle delay.
    await browser.pause(800)
    expect(await allow.isEnabled()).toBe(false)
    // Playwright's `click({ force: true })`: a click on the disabled button anyway.
    await allow.click().catch(() => undefined)
    expect(await settledWithin(reply, 500)).toBe('pending')

    await byTestId('claude-deny').click()
    expect(await reply).toEqual({ status: 200, body: DENY_BODY })
  })

  it('Enter and Space on the focused Permitir button never decide', async () => {
    await launchClaude()
    const bridge = await installClaudeHooks()

    const { reply } = await holdPermission(bridge, 'api-server')
    await requestIntent('expand')
    await expect(capsule()).toHaveAttribute('data-mode', 'permission')
    const allow = byTestId('claude-allow')
    await settled('claude-allow')
    await inPage(() =>
      (globalThis as unknown as { document: { querySelector(s: string): { focus(): void } | null } }).document
        .querySelector('[data-testid="claude-allow"]')
        ?.focus(),
    )
    await expect(allow).toBeFocused()
    await browser.keys('Enter')
    await browser.keys('Space')
    await browser.keys('Enter')

    expect(await settledWithin(reply, 1000)).toBe('pending')
    await expect(byTestId('claude-permission')).toBeDisplayed()

    // Release it (Claude falls back to its own prompt) so nothing stays open.
    await postHook(bridge.hook, hookEvent('api-server', 'PostToolUse', { tool_name: 'Bash' }))
    expect(await reply).toEqual({ status: 200, body: '' })
  })

  it('Control Center installs with a diff, keeps foreign hooks, and uninstalls back to the original', async () => {
    const seeded = `${JSON.stringify(
      {
        theme: 'dark',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo coucou' }] }] },
      },
      null,
      2,
    )}\n`
    // The seed's foreign hook must show in the preview: the app reads this run's file.
    await launchClaude({ seed: seeded, proof: 'echo coucou' })
    await openClaudePage()

    await ccInstall().click()
    await expectPreviewOfTempFile()
    const diff = ccDiff()
    await expect(diff).toHaveText(expect.stringContaining('x-notch-hook'))
    await expect(diff).toHaveText(expect.stringContaining('PermissionRequest'))
    // The token is masked in the preview.
    await expect(diff).toHaveText(expect.stringContaining('••••••'))
    // Nothing is written before confirming.
    expect(readClaudeSettings()).toBe(seeded)

    await ccConfirmInstall().click()
    await eventually(async () => readClaudeSettings(), (text) => text.includes('x-notch-hook'), 'the installed hooks')
    const installed = JSON.parse(readClaudeSettings()) as {
      theme: string
      hooks: Record<string, { hooks: { type: string; command?: string }[] }[]>
    }
    expect(installed.theme).toBe('dark')
    expect(installed.hooks['Stop']?.[0]?.hooks[0]).toEqual({ type: 'command', command: 'echo coucou' })
    expect(installed.hooks['Stop']).toHaveLength(2)
    expect(installed.hooks['PermissionRequest']).toHaveLength(1)

    await ccUninstall().click()
    await ccConfirmUninstall().click()
    await eventually(async () => readClaudeSettings(), (text) => text === seeded, 'the original settings.json back')
  })
})
