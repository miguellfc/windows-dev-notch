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
  type FakeMessage,
} from './fixtures/fake-gmail'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }
/** Where the replaced `shell.openExternal` keeps the URLs main asked to open. */
type OpenedHost = { __notchOpened?: string[] }
type TestClockHost = { __notchTestClock: { advance: (ms: number) => Promise<void> } }

const INBOX = 'https://mail.google.com/mail/u/0/#inbox'

let userData: string
let launched: ElectronApplication | undefined
let fake: FakeGmail | undefined

type Alerts = { enabled: boolean; hideContent: boolean; sound: boolean }
/** Alerts on, silent: no chime in a test run. */
const QUIET_ALERTS: Alerts = { enabled: true, hideContent: false, sound: false }

/** Mails that arrive during a test (fictional, like the seed). */
const NEW_MAILS = {
  rosa: {
    id: '18c0b1',
    threadId: '18c0b1f0',
    from: '"Rosa Ejemplo" <rosa@example.com>',
    sender: 'Rosa Ejemplo',
    subject: 'Entradas para el concierto',
    snippet: 'Ya tengo las entradas para el sábado.',
  },
  pablo: {
    id: '18c0b2',
    threadId: '18c0b2f0',
    from: 'Pablo Ficticio <pablo@example.net>',
    sender: 'Pablo Ficticio',
    subject: 'Presupuesto de la reforma',
    snippet: 'Te paso el presupuesto actualizado.',
  },
  irene: {
    id: '18c0b3',
    threadId: '18c0b3f0',
    from: 'Irene Prueba <irene@example.org>',
    sender: 'Irene Prueba',
    subject: 'Horario del lunes',
    snippet: 'El lunes empezamos a las ocho.',
  },
} satisfies Record<string, Omit<FakeMessage, 'unread' | 'minutesAgo'>>

const writeSettings = (gmail: { clientId: string; clientSecret: string }, alerts: Alerts = QUIET_ALERTS): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 5,
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
      gmail: { ...gmail, alerts },
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
  // Dev-only clock: moving it forward fires Gmail's 60 s poll at once (ignored by a packaged build).
  env['NOTCH_TEST_CLOCK'] = '1'
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

/** Moves the dev-only test clock: a Gmail poll that falls due runs now. */
const advance = (app: ElectronApplication, ms: number) =>
  app.evaluate(async (_electron, delta) => {
    await (globalThis as unknown as TestClockHost).__notchTestClock.advance(delta)
  }, ms)

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
const signInThroughBrowser = async (
  app: ElectronApplication,
  cc: Page,
  server: FakeGmail,
  outcome: 'ok' | 'expired' = 'ok',
): Promise<void> => {
  const before = (await openedUrls(app)).length
  await cc.getByRole('button', { name: 'Iniciar sesión' }).click()
  await expect(cc.getByTestId('gmail-session')).toHaveAttribute('data-status', 'signing-in')
  await expect(cc.getByTestId('gmail-session')).toContainText('Esperando al navegador')

  let consent = ''
  await expect
    .poll(async () => {
      consent = (await openedUrls(app)).slice(before).find((url) => url.startsWith(`${server.base}/o/oauth2/v2/auth?`)) ?? ''
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

  await expect(cc.getByTestId('gmail-session')).toHaveAttribute('data-status', outcome)
  if (outcome === 'ok') await expect(cc.getByTestId('gmail-session')).toContainText(`Conectado como ${FAKE_ACCOUNT}`)
}

/** Client seeded in settings, then a real (fake-Google) sign-in; the capsule shows the 3 unread. */
const signedIn = async (server: FakeGmail, alerts: Alerts = QUIET_ALERTS): Promise<{ app: ElectronApplication; notch: Page; cc: Page }> => {
  writeSettings({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET }, alerts)
  const { app, notch } = await launch(server)
  const cc = await openControlCenterGmail(app, notch)
  await signInThroughBrowser(app, cc, server)
  await expect(notch.getByTestId('metric-mail')).toHaveAttribute('aria-label', '3 correos sin leer')
  return { app, notch, cc }
}

/** Every log line main wrote so far. */
const readLogs = (): string =>
  readdirSync(join(userData, 'logs'))
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(userData, 'logs', name), 'utf8'))
    .join('\n')

/** Pieces of a mail that must never reach the log: sender, address, subject, snippet, body lines, links. */
const mailData = (message: Omit<FakeMessage, 'unread' | 'minutesAgo'>): string[] => {
  const address = /<([^>]+)>/.exec(message.from)?.[1] ?? message.from
  const pieces = [message.subject, message.sender, address, message.snippet, message.snippet.replaceAll('&amp;', '&')]
  const body = message.body
  if (body?.kind === 'html') pieces.push('Ver la reserva', 'reservas.example.org', '¿Te viene bien a las nueve?')
  else if (body) pieces.push(...body.text.split('\r\n').filter((line) => line.length >= 12))
  if (body?.kind === 'attachment') pieces.push(body.filename)
  return pieces
}

/** No token, secret or mail data (seed and new mails) in the log. */
const expectCleanLogs = (server: FakeGmail): void => {
  const logs = readLogs()
  for (const secret of [FAKE_CLIENT_SECRET, ...server.issuedTokens]) expect(logs).not.toContain(secret)
  for (const message of [...FAKE_MESSAGES, ...Object.values(NEW_MAILS)]) {
    for (const piece of mailData(message)) expect(logs, 'mail data in the log').not.toContain(piece)
  }
  expect(logs).not.toContain('docs.example.com')
}

/** The list item (li) of one message. */
const rowOf = (notch: Page, id: string) => notch.locator(`[data-message-id="${id}"]`)
/** Borrar ignores clicks for its first 300 ms (a double click never confirms). */
const CONFIRM_ARM_MS = 400

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

  // A row opens the reader in the notch (not the browser); its "Abrir en Gmail" hands main only
  // the id, and main opens the thread in the browser.
  await rows.nth(1).click()
  const second = recent[1]!
  await expect(notch.getByTestId('gmail-reader')).toHaveAttribute('data-state', 'ready')
  await expect(notch.getByTestId('gmail-reader-subject')).toHaveText(second.subject)
  expect(await openedUrls(app)).not.toContain(`${INBOX}/${second.threadId}`)
  await notch.getByTestId('gmail-reader-open').click()
  await expect.poll(() => openedUrls(app)).toContain(`${INBOX}/${second.threadId}`)
  await notch.getByTestId('gmail-reader-back').click()
  await expect(rows).toHaveCount(5)
  await notch.getByTestId('gmail-open-inbox').click()
  await expect.poll(() => openedUrls(app)).toContain(INBOX)
  // Nothing but the consent screen and Gmail was ever opened.
  for (const url of await openedUrls(app)) expect(url.startsWith(`${server.base}/o/oauth2/v2/auth?`) || url.startsWith(INBOX)).toBe(true)

  // The app spoke the protocol: PKCE verifier and grant type on /token, bearer on every API call.
  expect(server.violations).toEqual([])
  expect(server.hits['POST /token:authorization_code']).toBe(1)
  expect(server.hits['GET messages']).toBeGreaterThanOrEqual(2)

  // No token, secret or mail data in the log.
  expectCleanLogs(server)
})

test('a revoked session (401) shows "Vuelve a iniciar sesión" in the view and the Control Center', async () => {
  const server = fake!
  // Client seeded in settings; the session still comes from the (fake) OAuth flow, never from a seeded token.
  const { notch, cc } = await signedIn(server)

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

test('read a message as plain text: links (never javascript:), attachments, open a link, ES/EN captures', async () => {
  const server = fake!
  const { app, notch } = await signedIn(server)
  await openGmailView(notch)
  const rows = notch.getByTestId('gmail-message')
  await expect(rows).toHaveCount(5)
  const [ana, , luis, facturas] = FAKE_MESSAGES

  // A text/plain mail: sender, address, subject, the body as text and the URL in it as a link.
  await rowOf(notch, ana!.id).getByTestId('gmail-message').click()
  const reader = notch.getByTestId('gmail-reader')
  await expect(reader).toHaveAttribute('data-state', 'ready')
  await expect(notch.getByTestId('gmail-reader-from')).toHaveText('Ana Ejemplo')
  await expect(reader).toContainText('ana@example.com')
  await expect(notch.getByTestId('gmail-reader-subject')).toHaveText(ana!.subject)
  const body = notch.getByTestId('gmail-reader-body')
  await expect(body).toContainText('La lectura se ve bien; el pie podría ir un poco más separado.')
  const links = notch.getByTestId('gmail-reader-link')
  await expect(links).toHaveCount(1)
  await expect(links.first()).toContainText('https://docs.example.com/notch/gmail-revision')
  // Opening a mail does not mark it read; nothing was sent to Gmail but the read.
  expect(server.modified).toEqual([])
  await expect(notch.getByTestId('gmail-reader-mark-read')).toBeVisible()
  await reader.locator('header').hover()
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-reader-es.png' })
  await setLanguage(notch, 'en')
  await expect(notch.getByTestId('gmail-reader-mark-read')).toContainText('Mark as read')
  await expect(notch.getByTestId('gmail-reader-open')).toContainText('Open in Gmail')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-reader-en.png' })
  await setLanguage(notch, 'es')
  await expect(notch.getByTestId('gmail-reader-open')).toContainText('Abrir en Gmail')

  // A link: the notch names it by index, main opens the URL it extracted (captured, no browser).
  await links.first().click()
  await expect.poll(() => openedUrls(app)).toContain('https://docs.example.com/notch/gmail-revision')

  // An HTML-only mail: converted to text in main; no script/style text, no javascript: link.
  await notch.getByTestId('gmail-reader-back').click()
  await expect(rows).toHaveCount(5)
  await rowOf(notch, luis!.id).getByTestId('gmail-message').click()
  await expect(reader).toHaveAttribute('data-state', 'ready')
  await expect(notch.getByTestId('gmail-reader-subject')).toHaveText(luis!.subject)
  await expect(body).toContainText('¿Te viene bien a las nueve? Reservo para cuatro & aviso al resto.')
  await expect(body).toContainText('Ver la reserva')
  await expect(body).not.toContainText('window.stolen')
  await expect(body).not.toContainText('color: red')
  await expect(reader).not.toContainText('javascript:')
  await expect(links).toHaveCount(1)
  await expect(links.first()).toContainText('https://reservas.example.org/viernes?mesa=4')
  await expect(links.first()).toContainText('Ver la reserva')
  // HTML is never rendered: no element of the mail reached the DOM.
  expect(await reader.locator('a, img, script, style').count()).toBe(0)
  await links.first().click()
  await expect.poll(() => openedUrls(app)).toContain('https://reservas.example.org/viernes?mesa=4')
  // "Abrir en Gmail" in the reader opens the thread.
  await notch.getByTestId('gmail-reader-open').click()
  await expect.poll(() => openedUrls(app)).toContain(`${INBOX}/${luis!.threadId}`)

  // A mail with an attachment: the text part, and "1 adjunto" (attachments are never downloaded).
  await notch.keyboard.press('Escape')
  await expect(rows).toHaveCount(5)
  await rowOf(notch, facturas!.id).getByTestId('gmail-message').click()
  await expect(reader).toHaveAttribute('data-state', 'ready')
  await expect(body).toContainText('Te la adjuntamos también en PDF.')
  await expect(notch.getByTestId('gmail-reader-attachments')).toHaveText('1 adjunto')
  await expect(links).toHaveCount(0)

  // Only the links main extracted (and Gmail threads, the consent screen) were ever opened.
  for (const url of await openedUrls(app)) {
    expect(
      url.startsWith(`${server.base}/o/oauth2/v2/auth?`) ||
        url.startsWith(INBOX) ||
        url === 'https://docs.example.com/notch/gmail-revision' ||
        url === 'https://reservas.example.org/viernes?mesa=4',
      url,
    ).toBe(true)
  }
  expect(server.hits['GET message full']).toBe(3)
  expect(server.modified).toEqual([])
  expect(server.deleted).toEqual([])
  expect(server.violations).toEqual([])
  expectCleanLogs(server)
})

test('mark as read lowers the count; delete asks first, cancel deletes nothing, confirm deletes for good', async () => {
  const server = fake!
  const { notch } = await signedIn(server)
  await openGmailView(notch)
  const rows = notch.getByTestId('gmail-message')
  await expect(rows).toHaveCount(5)
  const [ana, builds, luis] = FAKE_MESSAGES
  const unread = notch.getByTestId('gmail-unread')
  await expect(unread).toHaveText('3 sin leer')

  // Mark as read from the row: Gmail gets "remove UNREAD" and the count drops.
  const anaRow = rowOf(notch, ana!.id)
  await anaRow.hover()
  await anaRow.getByTestId('gmail-row-mark-read').click()
  await expect(unread).toHaveText('2 sin leer')
  await expect(anaRow.getByTestId('gmail-message')).not.toHaveAttribute('data-unread')
  expect(server.modified).toEqual([ana!.id])

  // Delete from the row asks first; Cancel leaves the mail where it was.
  const buildsRow = rowOf(notch, builds!.id)
  await buildsRow.hover()
  await buildsRow.getByTestId('gmail-row-delete').click()
  const confirm = notch.getByTestId('gmail-message-confirm')
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('¿Borrar para siempre?')
  await expect(notch.getByTestId('gmail-delete-cancel')).toBeFocused()
  await notch.mouse.move(0, 0)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-delete-confirm-es.png' })
  await notch.getByTestId('gmail-delete-cancel').click()
  await expect(confirm).toHaveCount(0)
  await expect(buildsRow.getByTestId('gmail-message')).toBeVisible()
  // Esc cancels too (and stays in the view).
  await buildsRow.hover()
  await buildsRow.getByTestId('gmail-row-delete').click()
  await expect(confirm).toHaveCount(1)
  await notch.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'gmail')
  expect(server.deleted).toEqual([])
  expect(server.hits['DELETE message']).toBeUndefined()

  // Confirmed: the row goes, the server got DELETE, the list refills from Gmail.
  await buildsRow.hover()
  await buildsRow.getByTestId('gmail-row-delete').click()
  await notch.waitForTimeout(CONFIRM_ARM_MS)
  await notch.getByTestId('gmail-delete-confirm-button').click()
  await expect(buildsRow).toHaveCount(0)
  expect(server.deleted).toEqual([builds!.id])
  await expect(rows).toHaveCount(5)
  await expect(notch.getByTestId('gmail-list')).not.toContainText(builds!.subject)

  // From the reader: mark as read, then delete behind the same question; back to the list.
  await rowOf(notch, luis!.id).getByTestId('gmail-message').click()
  const reader = notch.getByTestId('gmail-reader')
  await expect(reader).toHaveAttribute('data-state', 'ready')
  await notch.getByTestId('gmail-reader-mark-read').click()
  await expect(notch.getByTestId('gmail-reader-mark-read')).toHaveCount(0)
  await expect(unread).toHaveCount(0) // the reader replaces the list header
  expect(server.modified).toEqual([ana!.id, luis!.id])
  await notch.getByTestId('gmail-reader-delete').click()
  await expect(notch.getByTestId('gmail-delete-confirm')).toBeVisible()
  await notch.getByTestId('gmail-delete-cancel').click()
  await expect(notch.getByTestId('gmail-delete-confirm')).toHaveCount(0)
  expect(server.deleted).toEqual([builds!.id])
  await notch.getByTestId('gmail-reader-delete').click()
  await notch.waitForTimeout(CONFIRM_ARM_MS)
  await notch.getByTestId('gmail-delete-confirm-button').click()
  await expect(reader).toHaveCount(0)
  await expect(rows).toHaveCount(5)
  await expect(rowOf(notch, luis!.id)).toHaveCount(0)
  expect(server.deleted).toEqual([builds!.id, luis!.id])
  await expect(unread).toHaveText('1 sin leer')

  // Back on the compact capsule the count says the same.
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'dismiss' }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('metric-mail')).toHaveAttribute('aria-label', '1 correo sin leer')
  expect(server.mailbox.map((m) => m.id)).not.toContain(builds!.id)
  expect(server.violations).toEqual([])
  expectCleanLogs(server)
})

test('new mail: a capsule alert with sender and subject for ~6 s, "Correo nuevo" when hidden, a click opens the reader', async () => {
  const server = fake!
  const { app, notch, cc } = await signedIn(server)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')

  // Mail arrives; the next 60 s poll (the test clock moves it forward) sees a new unread id.
  server.addMail(NEW_MAILS.rosa)
  await advance(app, 60_000)
  const alert = notch.getByTestId('mail-alert')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  const shownAt = Date.now()
  await expect(alert).toHaveText(`${NEW_MAILS.rosa.sender} · ${NEW_MAILS.rosa.subject}`)
  await expect(alert).toHaveAttribute('aria-live', 'polite')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-alert-es.png' })
  // It ends on its own after about 6 s, back to the capsule with the new count.
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact', { timeout: 12_000 })
  const shownFor = Date.now() - shownAt
  expect(shownFor).toBeGreaterThan(4_000)
  expect(shownFor).toBeLessThan(9_000)
  await expect(notch.getByTestId('metric-mail')).toHaveAttribute('aria-label', '4 correos sin leer')

  // Hide sender and subject (Control Center): the next alert only says "Correo nuevo".
  const hide = cc.getByRole('switch', { name: 'Ocultar remitente y asunto' })
  await hide.click()
  await expect(hide).toHaveAttribute('aria-checked', 'true')
  const metadataBefore = server.hits['GET message'] ?? 0
  server.addMail(NEW_MAILS.pablo)
  await advance(app, 60_000)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  await expect(alert).toHaveText('Correo nuevo')
  await expect(alert).not.toContainText(NEW_MAILS.pablo.sender)
  // Hidden content is not even asked of Gmail.
  expect(server.hits['GET message'] ?? 0).toBe(metadataBefore)

  // A click on a one-mail alert opens the Gmail view straight on that message.
  await alert.click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'gmail')
  await expect(notch.getByTestId('gmail-reader')).toHaveAttribute('data-state', 'ready')
  await expect(notch.getByTestId('gmail-reader-subject')).toHaveText(NEW_MAILS.pablo.subject)

  // With a panel open there is no alert (the mail still counts).
  await notch.keyboard.press('Escape')
  await notch.keyboard.press('Escape')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  const unreadBefore = server.hits['GET messages'] ?? 0
  server.addMail(NEW_MAILS.irene)
  await advance(app, 60_000)
  await expect.poll(() => server.hits['GET messages'] ?? 0).toBeGreaterThan(unreadBefore)
  await notch.waitForTimeout(1_000)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  await expect(alert).toHaveCount(0)
  // The pointer (left on the capsule by the click) leaves it, or the capsule would stay in peek.
  await notch.mouse.move(1, 1)
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'dismiss' }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('metric-mail')).toHaveAttribute('aria-label', '6 correos sin leer')
  await expect(alert).toHaveCount(0)

  expect(server.violations).toEqual([])
  expectCleanLogs(server)
})

test('a session without the full mail permission asks to sign in again for it', async () => {
  const server = fake!
  writeSettings({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET })
  const { app, notch } = await launch(server)
  const cc = await openControlCenterGmail(app, notch)

  // The consent asked for https://mail.google.com/ but Google granted only gmail.readonly: refused.
  server.grantReadonlyScope = true
  await signInThroughBrowser(app, cc, server, 'expired')
  await expect(cc.getByTestId('gmail-scope')).toContainText('Vuelve a iniciar sesión para conceder el nuevo permiso')
  await expect(cc.getByTestId('gmail-scope-denied')).toBeVisible()
  await expect(cc.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled()
  await expect(notch.getByTestId('metric-mail')).toHaveCount(0)
  // That token was never used.
  expect(server.hits['GET messages']).toBeUndefined()
  expect(server.hits['GET profile']).toBeUndefined()

  // Granted in full: the session works.
  server.grantReadonlyScope = false
  await signInThroughBrowser(app, cc, server)
  await expect(cc.getByTestId('gmail-scope')).toHaveCount(0)
  await expect(notch.getByTestId('metric-mail')).toHaveAttribute('aria-label', '3 correos sin leer')

  // A session whose refresh comes back with only gmail.readonly (a milestone-1 grant): once the
  // access token expires (test clock past its hour), the refresh is refused and the user is asked again.
  server.grantReadonlyScope = true
  const refreshes = server.hits['POST /token:refresh_token'] ?? 0
  await advance(app, 3_600_000)
  await expect(cc.getByTestId('gmail-session')).toHaveAttribute('data-status', 'expired')
  await expect(cc.getByTestId('gmail-scope')).toContainText('Vuelve a iniciar sesión para conceder el nuevo permiso')
  expect(server.hits['POST /token:refresh_token']).toBe(refreshes + 1)
  await expect(notch.getByTestId('metric-mail')).toHaveCount(0)
  await openGmailView(notch)
  // The notch names the missing permission too, with a way to the Control Center's Gmail page.
  const status = notch.getByTestId('gmail-status')
  await expect(status).toHaveAttribute('data-notice', 'scope')
  await expect(status).toContainText('Vuelve a iniciar sesión para conceder el nuevo permiso.')
  await expect(status.getByTestId('gmail-open-control-center')).toBeVisible()
  await settle(notch)
  await notch.screenshot({ path: 'test-results/gmail-scope-notch-es.png' })

  expect(server.violations).toEqual([])
  expectCleanLogs(server)
})
