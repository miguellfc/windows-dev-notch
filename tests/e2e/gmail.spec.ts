import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import {
  FAKE_ACCOUNT,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_MESSAGES,
  GMAIL_SCOPE,
  startFakeGmail,
  type FakeGmail,
} from './fixtures/fake-gmail'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }
/** Where the replaced `shell.openExternal` keeps the URLs main asked to open. */
type OpenedHost = { __notchOpened?: string[] }

const INBOX = 'https://mail.google.com/mail/u/0/#inbox'

let userData: string
let launched: ElectronApplication | undefined
let fake: FakeGmail | undefined

const writeSettings = (gmail: { clientId: string; clientSecret: string }): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 4,
      language: 'es',
      shortcut: 'Control+Alt+Space',
      launchAtLogin: false,
      reminders: { snoozeMinutes: 10, sound: false },
      systemAlerts: {
        cpu: { enabled: true, percent: 90, sustainSeconds: 30 },
        ram: { enabled: true, percent: 90 },
        battery: { enabled: true, percent: 15 },
        disk: { enabled: true, freePercent: 10 },
      },
      gmail,
    }),
    'utf8',
  )
}

const launch = async (server: FakeGmail): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Stay isolated from an installed notch and from the real ~/.claude/settings.json.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  // Google (consent, token, revoke and the Gmail API) is the local fake server.
  env['NOTCH_GMAIL_BASE_URL'] = server.base
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  // Never open the real browser: keep the URLs main asks to open (consent screen, Gmail threads).
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as unknown as OpenedHost).__notchOpened = opened
    shell.openExternal = (url: string) => {
      opened.push(url)
      return Promise.resolve()
    }
  })
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const openedUrls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => [...((globalThis as unknown as OpenedHost).__notchOpened ?? [])])

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')
const setLanguage = (notch: Page, language: 'es' | 'en') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)

const openControlCenterGmail = async (app: ElectronApplication, notch: Page): Promise<Page> => {
  const opened = app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter({ page: 'gmail' }))
  const cc = await opened
  await cc.waitForLoadState('domcontentloaded')
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  await expect(cc.getByTestId('gmail-page')).toBeVisible()
  return cc
}

const openGmailView = async (notch: Page): Promise<void> => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await notch.getByTestId('integration-gmail').click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'gmail')
  await expect(notch.getByTestId('gmail-panel')).toBeVisible()
}

/**
 * Iniciar sesión from the Control Center, then play the browser: load the consent URL main opened
 * (the fake Google answers with a redirect carrying a code) and GET the loopback redirect_uri.
 */
const signInThroughBrowser = async (app: ElectronApplication, cc: Page, server: FakeGmail): Promise<void> => {
  await cc.getByRole('button', { name: 'Iniciar sesión' }).click()
  await expect(cc.getByTestId('gmail-session')).toHaveAttribute('data-status', 'signing-in')
  await expect(cc.getByTestId('gmail-session')).toContainText('Esperando al navegador')

  let consent = ''
  await expect
    .poll(async () => {
      consent = (await openedUrls(app)).find((url) => url.startsWith(`${server.base}/o/oauth2/v2/auth?`)) ?? ''
      return consent
    })
    .not.toBe('')
  const asked = new URL(consent).searchParams
  expect(asked.get('client_id')).toBe(FAKE_CLIENT_ID)
  expect(asked.get('scope')).toBe(GMAIL_SCOPE)
  expect(asked.get('response_type')).toBe('code')
  expect(asked.get('code_challenge_method')).toBe('S256')
  expect(asked.get('access_type')).toBe('offline')
  const redirectUri = asked.get('redirect_uri') ?? ''
  expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  // The consent screen sends the browser back to the loopback with a code and the same state.
  const consented = await fetch(consent, { redirect: 'manual' })
  expect(consented.status).toBe(302)
  const back = new URL(consented.headers.get('location') ?? '')
  expect(`${back.origin}${back.pathname}`).toBe(redirectUri)
  expect(back.searchParams.get('state')).toBe(asked.get('state'))
  expect(back.searchParams.get('code')).toBeTruthy()

  // The browser's GET to redirect_uri?code=…&state=…
  const landing = await fetch(back)
  expect(landing.status).toBe(200)
  expect(await landing.text()).toContain('Developer Notch')

  await expect(cc.getByTestId('gmail-session')).toHaveAttribute('data-status', 'ok')
  await expect(cc.getByTestId('gmail-session')).toContainText(`Conectado como ${FAKE_ACCOUNT}`)
}

/** Every log line main wrote so far. */
const readLogs = (): string =>
  readdirSync(join(userData, 'logs'))
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(userData, 'logs', name), 'utf8'))
    .join('\n')

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-gmail-'))
  fake = await startFakeGmail()
})

test.afterEach(async () => {
  // A failed test must not leave Electron holding the temp profile, nor the fake server listening.
  await launched?.close().catch(() => undefined)
  launched = undefined
  await fake?.close().catch(() => undefined)
  fake = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('configure from Control Center, sign in, unread count in the capsule, 5 most recent, open in the browser', async () => {
  const server = fake!
  writeSettings({ clientId: '', clientSecret: '' })
  const { app, notch } = await launch(server)
  const cc = await openControlCenterGmail(app, notch)

  // Type the client, save it, then sign in through the page's button.
  await expect(cc.getByRole('button', { name: 'Iniciar sesión' })).toBeDisabled()
  await cc.getByLabel('ID de cliente').fill(FAKE_CLIENT_ID)
  await cc.getByLabel('Secreto de cliente').fill(FAKE_CLIENT_SECRET)
  await cc.getByRole('button', { name: 'Guardar' }).click()
  await expect(cc.getByTestId('gmail-client-message')).toHaveText('Guardado')
  await signInThroughBrowser(app, cc, server)

  // Settings page, signed in (the window is Mica: give the capture the dark backdrop it has on screen).
  await cc.addStyleTag({ content: 'html, body { background: #0d0d0f !important }' })
  await cc.locator('main').evaluate((el) => el.scrollTo(0, 0))
  await settle(cc)
  await cc.screenshot({ path: 'test-results/gmail-settings.png' })

  // The poll right after sign-in puts the unread count of Primary in the compact capsule.
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  const mail = notch.getByTestId('metric-mail')
  await expect(mail).toHaveAttribute('aria-label', '3 correos sin leer')
  // The visible figure (an invisible "99+" beside it reserves the width).
  await expect(mail.locator('span span').last()).toHaveText('3')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-capsule-es.png' })

  // The view: the 5 most recent messages of Primary, newest first, unread ones marked.
  await openGmailView(notch)
  const rows = notch.getByTestId('gmail-message')
  await expect(rows).toHaveCount(5)
  const recent = FAKE_MESSAGES.slice(0, 5)
  for (const [index, message] of recent.entries()) {
    const row = rows.nth(index)
    await expect(row).toContainText(message.sender)
    await expect(row).toContainText(message.subject)
    if (message.unread) await expect(row).toHaveAttribute('data-unread', 'true')
    else await expect(row).not.toHaveAttribute('data-unread')
  }
  // Snippets are HTML-decoded and shown as text.
  await expect(rows.nth(2)).toContainText('cuatro & aviso')
  await expect(notch.getByTestId('gmail-unread')).toHaveText('3 sin leer')
  // The click on the tile left the (page) pointer over the first row: rest it on the title instead.
  await notch.getByTestId('gmail-panel').locator('h2').hover()
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-view-es.png' })

  await setLanguage(notch, 'en')
  await expect(notch.getByTestId('gmail-unread')).toHaveText('3 unread')
  await expect(notch.getByTestId('gmail-open-inbox')).toContainText('Open Gmail')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-view-en.png' })
  await setLanguage(notch, 'es')
  await expect(notch.getByTestId('gmail-unread')).toHaveText('3 sin leer')

  // Opening a message hands main only its id; main opens the thread in the browser.
  await rows.nth(1).click()
  const second = recent[1]!
  await expect.poll(() => openedUrls(app)).toContain(`${INBOX}/${second.threadId}`)
  await notch.getByTestId('gmail-open-inbox').click()
  await expect.poll(() => openedUrls(app)).toContain(INBOX)
  // Nothing but the consent screen and Gmail was ever opened.
  for (const url of await openedUrls(app)) expect(url.startsWith(`${server.base}/o/oauth2/v2/auth?`) || url.startsWith(INBOX)).toBe(true)

  // The app spoke the protocol: PKCE verifier and grant type on /token, bearer on every API call.
  expect(server.violations).toEqual([])
  expect(server.hits['POST /token:authorization_code']).toBe(1)
  expect(server.hits['GET messages']).toBeGreaterThanOrEqual(2)

  // No token, secret or mail data in the log.
  const logs = readLogs()
  for (const secret of [FAKE_CLIENT_SECRET, ...server.issuedTokens]) expect(logs).not.toContain(secret)
  for (const message of FAKE_MESSAGES) {
    expect(logs).not.toContain(message.subject)
    expect(logs).not.toContain(message.sender)
    // The snippet as Gmail sends it (HTML-encoded) and as the notch shows it.
    expect(logs).not.toContain(message.snippet)
    expect(logs).not.toContain(message.snippet.replaceAll('&amp;', '&'))
  }
})

test('a revoked session (401) shows "Vuelve a iniciar sesión" in the view and the Control Center', async () => {
  const server = fake!
  // Client seeded in settings v4; the session still comes from the (fake) OAuth flow, never from a seeded token.
  writeSettings({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET })
  const { app, notch } = await launch(server)
  const cc = await openControlCenterGmail(app, notch)
  await signInThroughBrowser(app, cc, server)
  await expect(notch.getByTestId('metric-mail')).toHaveAttribute('aria-label', '3 correos sin leer')

  await openGmailView(notch)
  await expect(notch.getByTestId('gmail-message')).toHaveCount(5)

  // Google now refuses the access token and the refresh grant: one refresh, then expired.
  server.unauthorized = true
  await notch.getByTestId('gmail-refresh').click()
  const status = notch.getByTestId('gmail-status')
  await expect(status).toHaveAttribute('data-notice', 'expired')
  await expect(status).toContainText('Vuelve a iniciar sesión')
  await expect(notch.getByTestId('gmail-message')).toHaveCount(0)
  await expect(notch.getByTestId('gmail-open-control-center')).toBeVisible()
  expect(server.hits['POST /token:refresh_token']).toBe(1)

  await expect(cc.getByTestId('gmail-session')).toHaveAttribute('data-status', 'expired')
  await expect(cc.getByTestId('gmail-expired')).toContainText('Vuelve a iniciar sesión')
  await expect(cc.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled()

  // Back on the compact capsule the mail block is gone.
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'dismiss' }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('metric-mail')).toHaveCount(0)
  expect(server.violations).toEqual([])
})

test('without a client id the view asks to set Gmail up in Control Center and nothing reaches Google', async () => {
  const server = fake!
  writeSettings({ clientId: '', clientSecret: '' })
  const { app, notch } = await launch(server)

  await openGmailView(notch)
  const status = notch.getByTestId('gmail-status')
  await expect(status).toHaveAttribute('data-notice', 'unconfigured')
  await expect(status).toContainText('Configura Gmail en Control Center')
  await expect(notch.getByTestId('metric-mail')).toHaveCount(0)

  // Its button opens the Control Center on the Gmail page, where signing in waits for a client.
  const opened = app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await notch.getByTestId('gmail-open-control-center').click()
  const cc = await opened
  await expect(cc.getByTestId('gmail-page')).toBeVisible()
  await expect(cc.getByRole('button', { name: 'Iniciar sesión' })).toBeDisabled()

  expect(server.hits).toEqual({})
  expect(await openedUrls(app)).toEqual([])
})
