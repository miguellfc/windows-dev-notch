import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'

type NotchWindow = { notch: NotchApi }
type HookReply = { status: number; body: string }
type Bridge = { url: URL; token: string }

const ALLOW_BODY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY_BODY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'

let userData: string
let settingsFile: string
let launched: ElectronApplication | undefined

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Never touch the real ~/.claude/settings.json nor collide with an installed notch on 47600.
  env['NOTCH_CLAUDE_SETTINGS'] = settingsFile
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const openControlCenterClaudePage = async (app: ElectronApplication, notch: Page): Promise<Page> => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const cc = await app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await cc.waitForLoadState('domcontentloaded')
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  await cc.getByRole('button', { name: 'Claude Code' }).click()
  return cc
}

const INSTALL = /Instalar hooks|Install hooks/
const CONFIRM_INSTALL = /Confirmar instalación|Confirm installation/
const UNINSTALL = /Desinstalar hooks|Uninstall hooks/
const CONFIRM_UNINSTALL = /Confirmar desinstalación|Confirm uninstall/

/** Installs the hooks through the Control Center UI, like a user would. */
const installFromControlCenter = async (app: ElectronApplication, notch: Page): Promise<void> => {
  const cc = await openControlCenterClaudePage(app, notch)
  await cc.getByRole('button', { name: INSTALL }).click()
  await cc.getByRole('button', { name: CONFIRM_INSTALL }).click()
  await expect.poll(() => readFileSync(settingsFile, 'utf8')).toContain('x-notch-hook')
  await cc.close()
}

/** URL and token exactly as Claude Code would read them: from the installed settings.json. */
const readBridge = (): Bridge => {
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    hooks: Record<string, { hooks: { type: string; url?: string; headers?: Record<string, string> }[] }[]>
  }
  const hook = settings.hooks['PermissionRequest']?.[0]?.hooks[0]
  if (!hook?.url || !hook.headers?.['x-notch-token']) throw new Error('Hooks are not installed')
  return { url: new URL(hook.url), token: hook.headers['x-notch-token'] }
}

/** POSTs a hook payload like Claude Code does. The promise settles when the bridge replies. */
const sendHook = (bridge: Bridge, payload: Record<string, unknown>): Promise<HookReply> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = request(
      bridge.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-notch-token': bridge.token,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })

const event = (session: string, name: string, extra: Record<string, unknown> = {}) => ({
  session_id: session,
  hook_event_name: name,
  cwd: `C:\\work\\${session}`,
  ...extra,
})

const permissionRequest = (session: string, command = 'npm run build') =>
  event(session, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command } })

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')

/** Resolves with the reply, or 'pending' if none arrived within `ms`. */
const settledWithin = (reply: Promise<HookReply>, ms: number): Promise<HookReply | 'pending'> =>
  Promise.race([reply, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))])

/** Sends a PermissionRequest and returns the held reply (boxed: returning the bare promise would await it) plus the POST→alert latency. */
const holdPermission = async (notch: Page, bridge: Bridge, session: string, command?: string) => {
  const startedAt = Date.now()
  const reply = sendHook(bridge, permissionRequest(session, command))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert', { timeout: 1000 })
  const latency = Date.now() - startedAt
  console.log(`PermissionRequest -> alert after ${latency} ms`)
  expect(latency).toBeLessThan(1000)
  return { reply }
}

const expand = (notch: Page) => notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))

/** Buttons stay disabled for 600 ms after a request appears. */
const settled = async (button: Locator) => {
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled({ timeout: 3000 })
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
  settingsFile = join(userData, 'claude-settings.json')
})

test.afterEach(async () => {
  // A failed test must not leave Electron holding the temp profile.
  await launched?.close().catch(() => undefined)
  launched = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('shows Claude sessions as dots (working then done) and in the panel', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()

  expect((await sendHook(bridge, event('api-server', 'UserPromptSubmit', { prompt: 'secret prompt' }))).status).toBe(200)
  const dots = notch.getByTestId('claude-dots')
  await expect(dots).toBeVisible()
  await expect(dots).toHaveAttribute('aria-label', /Claude Code.*(1)/)
  await expect(dots.locator('.status-dot')).toHaveCount(1)

  await sendHook(bridge, event('web-client', 'UserPromptSubmit'))
  await expect(dots.locator('.status-dot')).toHaveCount(2)
  await sendHook(bridge, event('api-server', 'Stop', { last_assistant_message: 'done' }))
  await expect(dots).toHaveAttribute('aria-label', /Claude Code/)
  await expect.poll(() => dots.getAttribute('aria-label')).toMatch(/(listo|done|terminad|finished)/i)
  await notch.waitForTimeout(600) // let the cross-fade finish
  await notch.screenshot({ path: 'test-results/m3-compact-dots.png' })

  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  const sessions = notch.getByTestId('claude-sessions')
  await expect(sessions).toBeVisible()
  await expect(sessions).toContainText('api-server')
  await expect(sessions).toContainText('web-client')
  await notch.waitForTimeout(600) // let the cross-fade finish
  await notch.screenshot({ path: 'test-results/m3-panel-sessions.png' })
  await app.close()
})

test('a permission request raises the alert in under 1 s and Permitir answers allow', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()
  await sendHook(bridge, event('api-server', 'UserPromptSubmit'))

  const { reply } = await holdPermission(notch, bridge, 'api-server', 'npm run build')
  const alert = notch.getByTestId('claude-alert')
  await expect(alert).toContainText('api-server')
  await expect(alert).toContainText('Bash')
  await notch.waitForTimeout(600) // let the cross-fade finish
  await notch.screenshot({ path: 'test-results/m3-alert.png' })

  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'permission')
  const card = notch.getByTestId('claude-permission')
  await expect(card).toContainText('npm run build')
  const allow = notch.getByTestId('claude-allow')
  await settled(allow)
  await notch.waitForTimeout(600) // let the cross-fade finish
  await notch.screenshot({ path: 'test-results/m3-permission.png' })
  await allow.click()

  const answer = await reply
  expect(answer.status).toBe(200)
  expect(answer.body).toBe(ALLOW_BODY)
  await expect(notch.getByTestId('claude-permission')).toBeHidden()
  await app.close()
})

test('Denegar answers deny', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()

  const { reply } = await holdPermission(notch, bridge, 'api-server', 'rm -rf build')
  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'permission')
  const deny = notch.getByTestId('claude-deny')
  await settled(deny)
  await deny.click()

  const answer = await reply
  expect(answer.status).toBe(200)
  expect(answer.body).toBe(DENY_BODY)
  await app.close()
})

test('a later PostToolUse of the same session releases the request with an empty 200 and clears the alert', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()

  const { reply } = await holdPermission(notch, bridge, 'api-server')
  // Claude's own prompt was answered in the terminal: the tool ran.
  expect((await sendHook(bridge, event('api-server', 'PostToolUse', { tool_name: 'Bash' }))).status).toBe(200)

  const answer = await reply
  expect(answer).toEqual({ status: 200, body: '' })
  await expect(notch.getByTestId('claude-alert')).toBeHidden()
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', 'alert')
  await app.close()
})

test('a UserPromptSubmit of the session releases a held request (answered or interrupted in Claude)', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()

  expect((await sendHook(bridge, event('api-server', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-1' }))).status).toBe(200)
  const { reply } = await holdPermission(notch, bridge, 'api-server')
  // A parallel call of the same session finishing does not release it...
  await sendHook(bridge, event('api-server', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-2' }))
  await sendHook(bridge, event('api-server', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu-2' }))
  expect(await settledWithin(reply, 500)).toBe('pending')
  // ...but the user moving on in Claude does.
  expect((await sendHook(bridge, event('api-server', 'UserPromptSubmit', { prompt: 'never mind' }))).status).toBe(200)

  expect(await reply).toEqual({ status: 200, body: '' })
  await expect(notch.getByTestId('claude-alert')).toBeHidden()
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', 'alert')
  await app.close()
})

test('Permitir stays disabled when the preview is truncated; Denegar still works', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()

  const { reply } = await holdPermission(notch, bridge, 'api-server', `echo ${'x'.repeat(2_395)}`)
  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'permission')
  const deny = notch.getByTestId('claude-deny')
  const allow = notch.getByTestId('claude-allow')
  await settled(deny)
  await expect(notch.getByTestId('claude-permission-truncated')).toContainText('400')
  await expect(allow).toBeDisabled()
  await expect(allow).toHaveAttribute('aria-description', /Claude/)
  // Still disabled well after the settle delay.
  await notch.waitForTimeout(800)
  await expect(allow).toBeDisabled()
  await allow.click({ force: true })
  expect(await settledWithin(reply, 500)).toBe('pending')

  await deny.click()
  expect(await reply).toEqual({ status: 200, body: DENY_BODY })
  await app.close()
})

test('Enter and Space on the focused Permitir button never decide', async () => {
  const { app, notch } = await launch()
  await installFromControlCenter(app, notch)
  const bridge = readBridge()

  const { reply } = await holdPermission(notch, bridge, 'api-server')
  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'permission')
  const allow = notch.getByTestId('claude-allow')
  await settled(allow)
  await allow.focus()
  await expect(allow).toBeFocused()
  await notch.keyboard.press('Enter')
  await notch.keyboard.press('Space')
  await notch.keyboard.press('Enter')

  expect(await settledWithin(reply, 1000)).toBe('pending')
  await expect(notch.getByTestId('claude-permission')).toBeVisible()

  // Release it (Claude falls back to its own prompt) so nothing stays open.
  await sendHook(bridge, event('api-server', 'PostToolUse', { tool_name: 'Bash' }))
  expect(await reply).toEqual({ status: 200, body: '' })
  await app.close()
})

test('Control Center installs with a diff, keeps foreign hooks, and uninstalls back to the original', async () => {
  const seeded = `${JSON.stringify(
    {
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo coucou' }] }] },
    },
    null,
    2,
  )}\n`
  writeFileSync(settingsFile, seeded, 'utf8')
  const { app, notch } = await launch()
  const cc = await openControlCenterClaudePage(app, notch)

  await cc.getByRole('button', { name: INSTALL }).click()
  const diff = cc.locator('pre')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText('x-notch-hook')
  await expect(diff).toContainText('PermissionRequest')
  // The token is masked in the preview.
  await expect(diff).toContainText('••••••')
  // The window is Mica (transparent page): a page capture would composite it on white, so give it the dark backdrop Mica shows on screen.
  await cc.addStyleTag({ content: 'html, body { background: #0d0d0f !important }' })
  await diff.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await cc.waitForTimeout(1000)
  await cc.screenshot({ path: 'test-results/m3-control-center.png' })
  // Nothing is written before confirming.
  expect(readFileSync(settingsFile, 'utf8')).toBe(seeded)

  await cc.getByRole('button', { name: CONFIRM_INSTALL }).click()
  await expect.poll(() => readFileSync(settingsFile, 'utf8')).toContain('x-notch-hook')
  const installed = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    theme: string
    hooks: Record<string, { hooks: { type: string; command?: string }[] }[]>
  }
  expect(installed.theme).toBe('dark')
  expect(installed.hooks['Stop']?.[0]?.hooks[0]).toEqual({ type: 'command', command: 'echo coucou' })
  expect(installed.hooks['Stop']).toHaveLength(2)
  expect(installed.hooks['PermissionRequest']).toHaveLength(1)

  await cc.getByRole('button', { name: UNINSTALL }).click()
  await cc.getByRole('button', { name: CONFIRM_UNINSTALL }).click()
  await expect.poll(() => readFileSync(settingsFile, 'utf8')).toBe(seeded)
  await app.close()
})
