/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Gmail, ported from tests/e2e/gmail.spec.ts (Electron). Google (the consent screen, `/token`,
// `/revoke` and the Gmail API) is the strict fake of tests/e2e/fixtures/fake-gmail.ts, started in this
// process on 127.0.0.1 for every test and passed per launch as `--e2e-env-NOTCH_GMAIL_BASE_URL`. Every
// test asserts the fake saw no protocol violation. URLs main would open (the consent screen, Gmail
// threads, links of a mail) are recorded (`NOTCH_OPEN_URL_LOG=1`, read with `__e2e:opened-urls`),
// never opened: the recorder is checked to be on before anything is clicked. The spec plays the
// browser: it reads the consent URL main "opened", fetches it from the fake with manual redirects and
// GETs the loopback `/callback` the fake redirects to, like Electron's spec. The 60 s poll and the
// access token's hour move with `__e2e:advance-clock`; the poll it fires runs after it answers, so its
// effects are polled with `eventually`.
//
// Hover is `pointer()` (`__e2e:pointer`) on the capsule and WebDriver's `moveTo()` on rows, as in the
// other Tauri specs.
// The client: test 1 types it in and saves it like Electron, then also loads it with "Cargar archivo JSON"
// (beyond Electron): `NOTCH_GMAIL_CLIENT_FILE` points the picker at a Google desktop client file in
// this test's temp profile (no dialog), so the Rust picker, its 64 KiB cap and its parser run on a
// real file. Every other test seeds the client in settings.json like Electron. Without that variable
// the picker would open the real dialog, so wdio.conf.mts sets it for every app to a missing file and
// every launch here passes a real path. A per-launch switch msedgedriver dropped would fall back to
// that inherited missing path, never to the dialog; the empty value is never used because the picker
// reads it as Cancel. Test 3 checks that a pick of a missing file is refused ("El archivo no es un
// cliente de escritorio de Google") with no dialog.
// GAP: the Electron spec closes the Control Center (`cc.close()`, test 7); here it stays open (no close
// channel, as in claude.spec.ts, code-review.spec.ts and redmine.spec.ts) and WebDriver switches
// between the two webviews.
// GAP: screenshots (test-results/gmail-*.png) are not assertions and are left out, as in the other
// Tauri specs; so are the `hover()` / `mouse.move` calls that only placed the pointer for them.
// GAP: `expandPanel` retries a panel opening lost to a focus-loss dismiss (the known follow-up of
// code-review.spec.ts and docs/tauri-e2e.md, with the Control Center left open); every other failure
// to open fails at once.
// GAP: text checks read `textContent` with whitespace collapsed (Playwright's `toHaveText`); WebDriver's
// visible text would apply CSS text transforms.
// The 6 s mail alert ends at 6 s of real time or when the test clock passes that point (the notch
// timers run over real time in the e2e build); the spec does not move the clock while an alert is up,
// so it checks the real-time end like Electron (4–9 s).
// Time zone: Gmail's Rust side has no local dates (the fake's `Date` header is RFC 2822 in GMT and
// main only turns it into a UTC ISO string; the renderer formats it), so the part 4 divergence does
// not apply and no zone alignment is needed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  FAKE_ACCOUNT,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_MESSAGES,
  GMAIL_SCOPE,
  startFakeGmail,
  type FakeGmail,
  type FakeMessage,
} from '../e2e/fixtures/fake-gmail'
import {
  DEFAULT_ALERTS,
  advanceClock,
  capsuleWindow,
  dataDir,
  eventually,
  fillValue,
  inPage,
  labelledField,
  launch,
  openControlCenter,
  openedUrls,
  pageTextAndValues,
  pointer,
  pointerToCorner,
  present,
  quitApp,
  readLogs,
  requestIntent,
  seededSettings,
  setLanguage,
  useWindow,
  whileHovered,
} from './helpers'

const INBOX = 'https://mail.google.com/mail/u/0/#inbox'
/** Gmail's poll rhythm. */
const POLL_MS = 60_000
/** Borrar ignores clicks for its first 300 ms (a double click never confirms). */
const CONFIRM_ARM_MS = 400
/** The Google desktop client file "Cargar archivo JSON" reads (test 1), in the test's temp profile. */
const CLIENT_FILE = 'gmail-client.json'

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

let fake: FakeGmail | undefined

const capsule = () => $('[data-testid="notch-capsule"]')
const byTestId = (id: string) => $(`[data-testid="${id}"]`)
const mode = () => capsule().getAttribute('data-mode')
const expectMode = (value: string, timeout?: number) => eventually(mode, (current) => current === value, `data-mode=${value}`, timeout)

/** `textContent` of the first match, whitespace collapsed (Playwright's `toHaveText`); null when absent. */
const textOf = (selector: string): Promise<string | null> =>
  inPage((sel: string) => {
    const el = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)
    return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  }, selector)
const expectText = (selector: string, text: string) => eventually(() => textOf(selector), (value) => value === text, `${selector} = "${text}"`)
const expectTextContaining = (selector: string, text: string) =>
  eventually(() => textOf(selector), (value) => value !== null && value.includes(text), `${selector} containing "${text}"`)
const count = async (selector: string): Promise<number> => (await $$(selector)).length
const expectCount = (selector: string, n: number, timeout?: number) =>
  eventually(() => count(selector), (value) => value === n, `${n} × ${selector}`, timeout)
const attributeOf = (selector: string, name: string): Promise<string | null> =>
  inPage(
    (sel: string, attr: string) =>
      (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document
        .querySelector(sel)
        ?.getAttribute(attr) ?? null,
    selector,
    name,
  )
const expectAttribute = (selector: string, name: string, value: string | null) =>
  eventually(() => attributeOf(selector, name), (current) => current === value, `${selector} ${name}=${String(value)}`)

/** Focuses the first element matching `selector` (Playwright's `locator.focus()`). */
const focus = (selector: string): Promise<void> =>
  inPage((sel: string) => {
    const el = (globalThis as unknown as { document: { querySelector(s: string): { focus(): void } | null } }).document.querySelector(sel)
    if (!el) throw new Error(`No element ${sel}`)
    el.focus()
  }, selector)

/** Whether the element that has the focus is the first match of `selector`. */
const isFocused = (selector: string): Promise<boolean> =>
  inPage((sel: string) => {
    const doc = (globalThis as unknown as { document: { activeElement: unknown; querySelector(s: string): unknown } }).document
    const el = doc.querySelector(sel)
    return el !== null && doc.activeElement === el
  }, selector)

/** Settings as Electron's `writeSettings` seeds them, with this client and these alerts. */
const settings = (gmail: { clientId: string; clientSecret: string }, alerts: Alerts = QUIET_ALERTS) => ({
  ...seededSettings(DEFAULT_ALERTS),
  gmail: { ...gmail, alerts },
})

/** A Google "Desktop app" client file of the fake client (fictional values). */
const clientFile = () => ({
  installed: {
    client_id: FAKE_CLIENT_ID,
    project_id: 'notch-e2e-example',
    auth_uri: 'https://accounts.example.test/o/oauth2/auth',
    token_uri: 'https://oauth2.example.test/token',
    client_secret: FAKE_CLIENT_SECRET,
    redirect_uris: ['http://localhost'],
  },
})

/** The client file's path: inside this run's profile, itself inside the system temp folder. */
function clientFilePath(): string {
  const data = resolve(dataDir())
  const file = resolve(join(data, CLIENT_FILE))
  if (!data.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()) || !file.startsWith(data)) {
    throw new Error(`Refusing to run: the client file would be ${file}, outside this run's temp profile`)
  }
  return file
}

/**
 * A fresh app on the fake Google, URLs recorded instead of opened, the picker answering the temp
 * client file (written unless `withClientFile` is false: then the picker's path does not exist).
 */
async function start(
  server: FakeGmail,
  gmail: { clientId: string; clientSecret: string },
  { alerts = QUIET_ALERTS, withClientFile = true }: { alerts?: Alerts; withClientFile?: boolean } = {},
): Promise<void> {
  // A malformed base turns the override off (the app would talk to Google): only ever the fake's
  // loopback origin.
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(server.base)) throw new Error(`Unexpected fake origin ${server.base}`)
  const files: Record<string, unknown> = { 'settings.json': settings(gmail, alerts) }
  if (withClientFile) files[CLIENT_FILE] = clientFile()
  await launch({
    fresh: true,
    // Always a real path: the empty value means Cancel. (A dropped switch would fall back to the
    // missing path wdio.conf.mts sets for every app, never to the dialog.)
    env: { NOTCH_GMAIL_BASE_URL: server.base, NOTCH_OPEN_URL_LOG: '1', NOTCH_GMAIL_CLIENT_FILE: clientFilePath() },
    files,
  })
  if (!withClientFile && existsSync(clientFilePath())) throw new Error('The client file should not exist')
  // The recorder must be on before anything is clicked (UNAVAILABLE otherwise): never a real browser.
  expect(await openedUrls()).toEqual([])
}

/** Opens the Control Center on its Gmail page; WebDriver stays on it. */
async function openGmailPage(): Promise<void> {
  await openControlCenter('gmail')
  await byTestId('gmail-page').waitForDisplayed()
}

const SESSION = '[data-testid="gmail-session"]'
const signInButton = () => $(SESSION).$('.//button[normalize-space()="Iniciar sesión"]')

/**
 * Iniciar sesión from the Control Center, then play the browser: load the consent URL main "opened"
 * (the fake Google answers with a redirect carrying a code) and GET the loopback redirect_uri.
 * WebDriver ends on the Control Center.
 */
async function signInThroughBrowser(server: FakeGmail, outcome: 'ok' | 'expired' = 'ok'): Promise<void> {
  await useWindow('control-center')
  const before = (await openedUrls()).length
  await signInButton().click()
  await expectAttribute(SESSION, 'data-status', 'signing-in')
  await expectTextContaining(SESSION, 'Esperando al navegador')

  const consent = await eventually(
    async () => (await openedUrls()).slice(before).find((url) => url.startsWith(`${server.base}/o/oauth2/v2/auth?`)) ?? '',
    (url) => url !== '',
    'the consent URL',
  )
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

  // The browser's GET to redirect_uri?code=…&state=… (the app's own loopback on 127.0.0.1).
  const landing = await fetch(back)
  expect(landing.status).toBe(200)
  expect(await landing.text()).toContain('Developer Notch')

  await expectAttribute(SESSION, 'data-status', outcome)
  if (outcome === 'ok') await expectTextContaining(SESSION, `Conectado como ${FAKE_ACCOUNT}`)
}

/** The capsule's mail block (the present copy): its aria-label, or null when absent. */
const mailMetric = async (): Promise<string | null> => {
  const blocks = await $$(present('metric-mail'))
  return blocks.length === 0 ? null : blocks[0]!.getAttribute('aria-label')
}
const expectMetric = (label: string | null) => eventually(mailMetric, (value) => value === label, `the mail block ${label ?? 'absent'}`)

/** Client seeded in settings, then a real (fake-Google) sign-in; the capsule shows the 3 unread. WebDriver ends on the notch. */
async function signedIn(server: FakeGmail): Promise<void> {
  await start(server, { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET })
  await openGmailPage()
  await signInThroughBrowser(server)
  await useWindow('notch')
  await whileHovered(() => expectMetric('3 correos sin leer').then(() => undefined))
  // Only the refresh token is stored, encrypted (DPAPI): the file exists after a sign-in.
  expect(existsSync(join(dataDir(), 'gmail-token.bin'))).toBe(true)
}

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

/**
 * No token, secret, account, mail data (seed and new mails) or the fake's address in the log; no
 * token or mail data in plain text in the data folder (the refresh token is in `gmail-token.bin`,
 * encrypted; the client stays in settings.json, and in the test's client file, by design).
 */
function expectCleanLogs(server: FakeGmail): void {
  const logs = readLogs()
  // The integration did log its status (a gmail line alone proves nothing: every launch logs the
  // picker switch at startup).
  expect(logs).toContain('Gmail status status=')
  const secrets = [FAKE_CLIENT_SECRET, ...server.issuedTokens]
  for (const secret of secrets) expect({ secret, inLog: logs.includes(secret) }).toEqual({ secret, inLog: false })
  const pieces = [...FAKE_MESSAGES, ...Object.values(NEW_MAILS)].flatMap(mailData)
  for (const piece of [...pieces, 'docs.example.com', FAKE_ACCOUNT, server.base.slice('http://'.length)]) {
    expect({ piece, inLog: logs.includes(piece) }).toEqual({ piece, inLog: false })
  }
  expect(server.issuedTokens.length).toBeGreaterThan(0)
  for (const name of readdirSync(dataDir())) {
    const file = join(dataDir(), name)
    if (!statSync(file).isFile()) continue
    const content = readFileSync(file).toString('utf8')
    for (const token of server.issuedTokens) expect({ name, plainToken: content.includes(token) }).toEqual({ name, plainToken: false })
    for (const piece of pieces) expect({ name, piece, mailData: content.includes(piece) }).toEqual({ name, piece, mailData: false })
  }
}

/** No token (nor, in the notch, the client secret) in the current window's markup or fields. */
async function expectNoTokenInDom(server: FakeGmail, window: 'notch' | 'control-center'): Promise<void> {
  const { html, values } = await pageTextAndValues()
  // The Control Center shows the user's own client secret in its (password) field, as in Electron.
  const secrets = window === 'notch' ? [FAKE_CLIENT_SECRET, ...server.issuedTokens] : server.issuedTokens
  for (const secret of secrets) {
    expect({ window, secret, inHtml: html.includes(secret), inFields: values.join('\n').includes(secret) }).toEqual({
      window,
      secret,
      inHtml: false,
      inFields: false,
    })
  }
}

/** Panel openings lost to a focus-loss dismiss and retried in this worker (reported at the end). */
let focusLossRetries = 0

/** Dismisses out of an open panel the controller has logged so far (`notch: mode change from expanded to … on Dismiss`). */
const panelDismissesLogged = (): number => (readLogs().match(/notch: mode change from expanded to \w+ on Dismiss/g) ?? []).length

/**
 * Opens the panel and checks it stays open: `expandPanel` of code-review.spec.ts (see its comment).
 * With the Control Center left open the panel can lose the OS focus right after expanding (known
 * follow-up); only that case, seen as a new "from expanded … on Dismiss" line in the controller's
 * log, is retried (at most 3 times, each logged and counted). Anything else fails at once.
 */
async function expandPanel(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const before = panelDismissesLogged()
    await requestIntent('expand')
    const reached = await expectMode('expanded', 3_000)
      .then(() => true)
      .catch(() => false)
    if (reached) {
      await browser.pause(300)
      if ((await mode()) === 'expanded') return
    }
    const focusLoss = await eventually(async () => panelDismissesLogged(), (n) => n > before, 'a focus-loss Dismiss in the log', 2_000)
      .then(() => true)
      .catch(() => false)
    if (!focusLoss) throw new Error(`The panel did not stay open, and not because of a focus-loss dismiss (mode ${String(await mode())})`)
    if (attempt === 3) throw new Error('The panel lost the focus right after opening 3 times in a row')
    focusLossRetries++
    console.log(`The panel lost the focus right after opening (attempt ${attempt}); opening it again (known follow-up)`)
    await pointer(false)
  }
}

const PANEL = '[data-testid="gmail-panel"]'
const READER = '[data-testid="gmail-reader"]'
const ROWS = '[data-testid="gmail-message"]'
const LINKS = '[data-testid="gmail-reader-link"]'
const UNREAD = '[data-testid="gmail-unread"]'
const STATUS = '[data-testid="gmail-status"]'
const ALERT = '[data-testid="mail-alert"]'
/** The list item (li) of one message. */
const rowOf = (id: string) => `[data-message-id="${id}"]`
const messageOf = (id: string) => `${rowOf(id)} [data-testid="gmail-message"]`

async function openGmailView(): Promise<void> {
  await useWindow('notch')
  await expandPanel()
  await byTestId('integration-gmail').click()
  await expectMode('gmail')
  await $(PANEL).waitForDisplayed()
}

/** The message rows as the page has them: `textContent` and `data-unread`. */
const rowsInfo = (): Promise<{ text: string; unread: string | null }[]> =>
  inPage((sel: string) =>
    Array.from(
      (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null; getAttribute(n: string): string | null }> } }).document.querySelectorAll(sel),
    ).map((el) => ({ text: el.textContent ?? '', unread: el.getAttribute('data-unread') })),
  ROWS)

const expectReaderReady = () => expectAttribute(READER, 'data-state', 'ready')

/** Back on the compact capsule: the pointer leaves (WebDriver's clicks left it over the capsule), then dismiss. */
async function backToPeek(): Promise<void> {
  await pointer(false)
  await requestIntent('dismiss')
  await expectMode('peek')
}

const notchWindowVisible = async (): Promise<boolean> => (await capsuleWindow()).visible

/** The opacity of a row's actions overlay (the buttons' grandparent), of row `id` or of the row holding the focus. */
const overlayOpacity = (which: string): Promise<string | null> =>
  inPage((id: string) => {
    type El = { querySelector(s: string): El | null; parentElement: El | null; contains(n: unknown): boolean }
    const w = globalThis as unknown as {
      document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; activeElement: unknown }
      getComputedStyle(el: unknown): { opacity: string }
    }
    const row =
      id === 'focused'
        ? Array.from(w.document.querySelectorAll('li[data-message-id]')).find((li) => li.contains(w.document.activeElement))
        : w.document.querySelector(`[data-message-id="${id}"]`)
    const overlay = row?.querySelector('[data-testid="gmail-row-delete"]')?.parentElement?.parentElement
    return overlay ? w.getComputedStyle(overlay).opacity : null
  }, which)

describe('Gmail (Tauri)', () => {
  beforeEach(async () => {
    fake = await startFakeGmail()
  })

  afterEach(async () => {
    // A failed test must not leave the fake server listening (the next launch quits the app).
    await fake?.close().catch(() => undefined)
    fake = undefined
  })

  after(async () => {
    console.log(`Panel openings retried after a focus-loss dismiss: ${focusLossRetries}`)
    await quitApp()
  })

  it('configure from Control Center, sign in, unread count in the capsule, 5 most recent, open in the browser', async () => {
    const server = fake!
    await start(server, { clientId: '', clientSecret: '' })
    await openGmailPage()

    // Type the client, save it, then sign in through the page's button.
    expect(await signInButton().isEnabled()).toBe(false)
    const page = '[data-testid="gmail-page"]'
    const idField = await labelledField(page, 'ID de cliente')
    const secretField = await labelledField(page, 'Secreto de cliente')
    await fillValue(idField, FAKE_CLIENT_ID)
    await fillValue(secretField, FAKE_CLIENT_SECRET)
    await $(page).$('.//button[normalize-space()="Guardar"]').click()
    await expectText('[data-testid="gmail-client-message"]', 'Guardado')
    const savedClient = () => (JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8')) as { gmail: { clientId: string } }).gmail.clientId
    expect(savedClient()).toBe(FAKE_CLIENT_ID)
    await expect($(secretField)).toHaveAttribute('type', 'password')

    // Beyond Electron: "Cargar archivo JSON" (the picker answers this test's client file, no dialog)
    // replaces an unsaved draft with the file's client and saves it.
    await fillValue(idField, 'borrador.apps.example.test')
    // Editing the draft clears the earlier "Guardado", so the next one comes from the file.
    await expectCount('[data-testid="gmail-client-message"]', 0)
    await $(page).$('.//button[normalize-space()="Cargar archivo JSON"]').click()
    await expectText('[data-testid="gmail-client-message"]', 'Guardado')
    // Only the pick answers the file's client in place of the typed draft.
    await eventually(async () => $(idField).getValue(), (value) => value === FAKE_CLIENT_ID, 'the client of the file in the field')
    expect(savedClient()).toBe(FAKE_CLIENT_ID)
    await eventually(async () => signInButton().isEnabled(), (enabled) => enabled, 'Iniciar sesión enabled')
    await signInThroughBrowser(server)
    await expectNoTokenInDom(server, 'control-center')

    // The poll right after sign-in puts the unread count of Primary in the compact capsule (on hover).
    await useWindow('notch')
    await whileHovered(async () => {
      await expectMetric('3 correos sin leer')
      // The visible figure (an invisible "99+" beside it reserves the width).
      const figure = await inPage((sel: string) => {
        const spans = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document.querySelectorAll(
          `${sel} span span`,
        )
        return spans.length ? (spans[spans.length - 1]!.textContent ?? '') : null
      }, present('metric-mail'))
      expect(figure).toBe('3')
    })

    // The view: the 5 most recent messages of Primary, newest first, unread ones marked.
    await openGmailView()
    await expectCount(ROWS, 5)
    const recent = FAKE_MESSAGES.slice(0, 5)
    const rows = await rowsInfo()
    for (const [index, message] of recent.entries()) {
      const row = rows[index]!
      expect(row.text).toContain(message.sender)
      expect(row.text).toContain(message.subject)
      expect({ index, unread: row.unread }).toEqual({ index, unread: message.unread ? 'true' : null })
    }
    // Snippets are HTML-decoded and shown as text.
    expect(rows[2]!.text).toContain('cuatro & aviso')
    await expectText(UNREAD, '3 sin leer')

    await setLanguage('en')
    await expectText(UNREAD, '3 unread')
    await expectTextContaining('[data-testid="gmail-open-inbox"]', 'Open Gmail')
    await setLanguage('es')
    await expectText(UNREAD, '3 sin leer')

    // A row opens the reader in the notch (not the browser); its "Abrir en Gmail" hands main only
    // the id, and main opens the thread in the browser.
    await $$(ROWS)[1]!.click()
    const second = recent[1]!
    await expectReaderReady()
    await expectText('[data-testid="gmail-reader-subject"]', second.subject)
    expect(await openedUrls()).not.toContain(`${INBOX}/${second.threadId}`)
    await byTestId('gmail-reader-open').click()
    await eventually(openedUrls, (urls) => urls.includes(`${INBOX}/${second.threadId}`), 'the thread opened')
    await byTestId('gmail-reader-back').click()
    await expectCount(ROWS, 5)
    await byTestId('gmail-open-inbox').click()
    await eventually(openedUrls, (urls) => urls.includes(INBOX), 'the inbox opened')
    // Nothing but the consent screen and Gmail was ever opened.
    for (const url of await openedUrls()) {
      expect({ url, allowed: url.startsWith(`${server.base}/o/oauth2/v2/auth?`) || url.startsWith(INBOX) }).toEqual({ url, allowed: true })
    }

    // The app spoke the protocol: PKCE verifier and grant type on /token, bearer on every API call.
    expect(server.violations).toEqual([])
    expect(server.hits['POST /token:authorization_code']).toBe(1)
    expect(server.hits['GET messages']).toBeGreaterThanOrEqual(2)

    // No token or secret in either window, nor (with mail data) in the log or the data folder.
    await expectNoTokenInDom(server, 'notch')
    await useWindow('control-center')
    await expectNoTokenInDom(server, 'control-center')
    expectCleanLogs(server)
  })

  it('a revoked session (401) shows "Vuelve a iniciar sesión" in the view and the Control Center', async () => {
    const server = fake!
    // Client seeded in settings; the session still comes from the (fake) OAuth flow, never from a seeded token.
    await signedIn(server)

    await openGmailView()
    await expectCount(ROWS, 5)

    // Google now refuses the access token and the refresh grant: one refresh, then expired.
    server.unauthorized = true
    await byTestId('gmail-refresh').click()
    await expectAttribute(STATUS, 'data-notice', 'expired')
    await expectTextContaining(STATUS, 'Vuelve a iniciar sesión')
    await expectCount(ROWS, 0)
    await expect(byTestId('gmail-open-control-center')).toBeDisplayed()
    expect(server.hits['POST /token:refresh_token']).toBe(1)

    await useWindow('control-center')
    await expectAttribute(SESSION, 'data-status', 'expired')
    await expectTextContaining('[data-testid="gmail-expired"]', 'Vuelve a iniciar sesión')
    expect(await signInButton().isEnabled()).toBe(true)

    // Back on the compact capsule the mail block is gone.
    await useWindow('notch')
    await backToPeek()
    await whileHovered(() => expectMetric(null).then(() => undefined))
    expect(server.violations).toEqual([])
    expectCleanLogs(server)
  })

  it('without a client id the view asks to set Gmail up in Control Center and nothing reaches Google', async () => {
    const server = fake!
    await start(server, { clientId: '', clientSecret: '' }, { withClientFile: false })

    await openGmailView()
    await expectAttribute(STATUS, 'data-notice', 'unconfigured')
    await expectTextContaining(STATUS, 'Configura Gmail en Control Center')
    expect(await count(present('metric-mail'))).toBe(0)

    // Its button opens the Control Center on the Gmail page, where signing in waits for a client.
    await byTestId('gmail-open-control-center').click()
    await useWindow('control-center')
    await byTestId('gmail-page').waitForDisplayed()
    await expectAttribute(SESSION, 'data-status', 'unconfigured')
    expect(await signInButton().isEnabled()).toBe(false)

    // Beyond Electron: with no client file where the picker points (wdio.conf.mts's default is such a
    // missing path), "Cargar archivo JSON" refuses it and opens no dialog.
    await $('[data-testid="gmail-page"]').$('.//button[normalize-space()="Cargar archivo JSON"]').click()
    await expectText('[data-testid="gmail-client-message"]', 'El archivo no es un cliente de escritorio de Google')
    await expectAttribute(SESSION, 'data-status', 'unconfigured')

    expect(server.hits).toEqual({})
    expect(await openedUrls()).toEqual([])
  })

  it('read a message as plain text: links (never javascript:), attachments, open a link, ES/EN', async () => {
    const server = fake!
    await signedIn(server)
    await openGmailView()
    await expectCount(ROWS, 5)
    const [ana, , luis, facturas] = FAKE_MESSAGES

    // A text/plain mail: sender, address, subject, the body as text and the URL in it as a link.
    await $(messageOf(ana!.id)).click()
    await expectReaderReady()
    await expectText('[data-testid="gmail-reader-from"]', 'Ana Ejemplo')
    await expectTextContaining(READER, 'ana@example.com')
    await expectText('[data-testid="gmail-reader-subject"]', ana!.subject)
    const body = '[data-testid="gmail-reader-body"]'
    await expectTextContaining(body, 'La lectura se ve bien; el pie podría ir un poco más separado.')
    await expectCount(LINKS, 1)
    await expectTextContaining(LINKS, 'https://docs.example.com/notch/gmail-revision')
    // Opening a mail does not mark it read; nothing was sent to Gmail but the read.
    expect(server.modified).toEqual([])
    await expect(byTestId('gmail-reader-mark-read')).toBeDisplayed()
    await setLanguage('en')
    await expectTextContaining('[data-testid="gmail-reader-mark-read"]', 'Mark as read')
    await expectTextContaining('[data-testid="gmail-reader-open"]', 'Open in Gmail')
    await setLanguage('es')
    await expectTextContaining('[data-testid="gmail-reader-open"]', 'Abrir en Gmail')

    // A link: the notch names it by index, main opens the URL it extracted (recorded, no browser).
    await $(LINKS).click()
    await eventually(openedUrls, (urls) => urls.includes('https://docs.example.com/notch/gmail-revision'), 'the link opened')

    // An HTML-only mail: converted to text in main; no script/style text, no javascript: link.
    await byTestId('gmail-reader-back').click()
    await expectCount(ROWS, 5)
    await $(messageOf(luis!.id)).click()
    await expectReaderReady()
    await expectText('[data-testid="gmail-reader-subject"]', luis!.subject)
    await expectTextContaining(body, '¿Te viene bien a las nueve? Reservo para cuatro & aviso al resto.')
    await expectTextContaining(body, 'Ver la reserva')
    const bodyText = (await textOf(body)) ?? ''
    expect(bodyText).not.toContain('window.stolen')
    expect(bodyText).not.toContain('color: red')
    expect((await textOf(READER)) ?? '').not.toContain('javascript:')
    await expectCount(LINKS, 1)
    await expectTextContaining(LINKS, 'https://reservas.example.org/viernes?mesa=4')
    await expectTextContaining(LINKS, 'Ver la reserva')
    // HTML is never rendered: no element of the mail reached the DOM.
    expect(await count(`${READER} a, ${READER} img, ${READER} script, ${READER} style`)).toBe(0)
    await $(LINKS).click()
    await eventually(openedUrls, (urls) => urls.includes('https://reservas.example.org/viernes?mesa=4'), 'the reservation link opened')
    // "Abrir en Gmail" in the reader opens the thread.
    await byTestId('gmail-reader-open').click()
    await eventually(openedUrls, (urls) => urls.includes(`${INBOX}/${luis!.threadId}`), 'the thread opened')

    // A mail with an attachment: the text part, and "1 adjunto" (attachments are never downloaded).
    // Esc from the reader (the focus is on its "Abrir en Gmail" button) goes back to the list.
    expect(await inPage(() => {
      const doc = (globalThis as unknown as { document: { activeElement: { closest(s: string): unknown } | null } }).document
      return doc.activeElement?.closest('[data-testid="gmail-reader"]') != null
    })).toBe(true)
    await browser.keys('Escape')
    await expectCount(ROWS, 5)
    await $(messageOf(facturas!.id)).click()
    await expectReaderReady()
    await expectTextContaining(body, 'Te la adjuntamos también en PDF.')
    await expectText('[data-testid="gmail-reader-attachments"]', '1 adjunto')
    await expectCount(LINKS, 0)

    // Only the links main extracted (and Gmail threads, the consent screen) were ever opened.
    for (const url of await openedUrls()) {
      const allowed =
        url.startsWith(`${server.base}/o/oauth2/v2/auth?`) ||
        url.startsWith(INBOX) ||
        url === 'https://docs.example.com/notch/gmail-revision' ||
        url === 'https://reservas.example.org/viernes?mesa=4'
      expect({ url, allowed }).toEqual({ url, allowed: true })
    }
    expect(server.hits['GET message full']).toBe(3)
    expect(server.modified).toEqual([])
    expect(server.deleted).toEqual([])
    expect(server.violations).toEqual([])
    await expectNoTokenInDom(server, 'notch')
    expectCleanLogs(server)
  })

  it('mark as read lowers the count; delete asks first, cancel deletes nothing, confirm deletes for good', async () => {
    const server = fake!
    await signedIn(server)
    await openGmailView()
    await expectCount(ROWS, 5)
    const [ana, builds, luis] = FAKE_MESSAGES
    await expectText(UNREAD, '3 sin leer')

    // Mark as read from the row: Gmail gets "remove UNREAD" and the count drops.
    await $(rowOf(ana!.id)).moveTo()
    await $(`${rowOf(ana!.id)} [data-testid="gmail-row-mark-read"]`).click()
    await expectText(UNREAD, '2 sin leer')
    await expectAttribute(messageOf(ana!.id), 'data-unread', null)
    expect(server.modified).toEqual([ana!.id])

    // Delete from the row asks first; Cancel leaves the mail where it was.
    const CONFIRM = '[data-testid="gmail-message-confirm"]'
    const deleteBuilds = async () => {
      await $(rowOf(builds!.id)).moveTo()
      await $(`${rowOf(builds!.id)} [data-testid="gmail-row-delete"]`).click()
    }
    await deleteBuilds()
    await expectCount(CONFIRM, 1)
    await expectTextContaining(CONFIRM, '¿Borrar para siempre?')
    await eventually(() => isFocused('[data-testid="gmail-delete-cancel"]'), (focused) => focused, 'the focus on Cancelar')
    await byTestId('gmail-delete-cancel').click()
    await expectCount(CONFIRM, 0)
    await expect($(messageOf(builds!.id))).toBeDisplayed()
    // Esc cancels too (and stays in the view).
    await deleteBuilds()
    await expectCount(CONFIRM, 1)
    await eventually(() => isFocused('[data-testid="gmail-delete-cancel"]'), (focused) => focused, 'the focus on Cancelar')
    await browser.keys('Escape')
    await expectCount(CONFIRM, 0)
    await expectMode('gmail')
    expect(server.deleted).toEqual([])
    expect(server.hits['DELETE message']).toBeUndefined()

    // Confirmed: the row goes, the server got DELETE, the list refills from Gmail.
    await deleteBuilds()
    await browser.pause(CONFIRM_ARM_MS)
    await byTestId('gmail-delete-confirm-button').click()
    await expectCount(rowOf(builds!.id), 0)
    expect(server.deleted).toEqual([builds!.id])
    await expectCount(ROWS, 5)
    expect((await textOf('[data-testid="gmail-list"]')) ?? '').not.toContain(builds!.subject)

    // From the reader: mark as read, then delete behind the same question; back to the list.
    await $(messageOf(luis!.id)).click()
    await expectReaderReady()
    await byTestId('gmail-reader-mark-read').click()
    await expectCount('[data-testid="gmail-reader-mark-read"]', 0)
    await expectCount(UNREAD, 0) // the reader replaces the list header
    expect(server.modified).toEqual([ana!.id, luis!.id])
    await byTestId('gmail-reader-delete').click()
    await expect(byTestId('gmail-delete-confirm')).toBeDisplayed()
    await byTestId('gmail-delete-cancel').click()
    await expectCount('[data-testid="gmail-delete-confirm"]', 0)
    expect(server.deleted).toEqual([builds!.id])
    await byTestId('gmail-reader-delete').click()
    await browser.pause(CONFIRM_ARM_MS)
    await byTestId('gmail-delete-confirm-button').click()
    await expectCount(READER, 0)
    await expectCount(ROWS, 5)
    await expectCount(rowOf(luis!.id), 0)
    expect(server.deleted).toEqual([builds!.id, luis!.id])
    await expectText(UNREAD, '1 sin leer')

    // Back on the compact capsule the count says the same.
    await backToPeek()
    await whileHovered(() => expectMetric('1 correo sin leer').then(() => undefined))
    expect(server.mailbox.map((m) => m.id)).not.toContain(builds!.id)
    expect(server.violations).toEqual([])
    expectCleanLogs(server)
  })

  it('new mail: a capsule alert with sender and subject for ~6 s, "Correo nuevo" when hidden, a click opens the reader', async () => {
    const server = fake!
    await signedIn(server)
    await expectMode('peek')

    // Mail arrives; the next 60 s poll (the test clock moves it forward) sees a new unread id.
    server.addMail(NEW_MAILS.rosa)
    await advanceClock(POLL_MS)
    await expectMode('alert')
    const shownAt = Date.now()
    await expectText(ALERT, `${NEW_MAILS.rosa.sender} · ${NEW_MAILS.rosa.subject}`)
    await expectAttribute(ALERT, 'aria-live', 'polite')
    // It ends on its own after about 6 s of real time (the clock is not moved meanwhile), back to the capsule with the new count.
    await expectMode('peek', 12_000)
    const shownFor = Date.now() - shownAt
    expect(shownFor).toBeGreaterThan(4_000)
    expect(shownFor).toBeLessThan(9_000)
    await whileHovered(() => expectMetric('4 correos sin leer').then(() => undefined))

    // Hide sender and subject (Control Center): the next alert only says "Correo nuevo".
    await useWindow('control-center')
    const hide = '[role="switch"][aria-label="Ocultar remitente y asunto"]'
    await $(hide).click()
    await expectAttribute(hide, 'aria-checked', 'true')
    const metadataBefore = server.hits['GET message'] ?? 0
    server.addMail(NEW_MAILS.pablo)
    await useWindow('notch')
    await advanceClock(POLL_MS)
    await expectMode('alert')
    await expectText(ALERT, 'Correo nuevo')
    expect((await textOf(ALERT)) ?? '').not.toContain(NEW_MAILS.pablo.sender)
    // Hidden content is not even asked of Gmail.
    expect(server.hits['GET message'] ?? 0).toBe(metadataBefore)

    // A click on a one-mail alert opens the Gmail view straight on that message.
    await $(ALERT).click()
    await expectMode('gmail')
    await expectReaderReady()
    await expectText('[data-testid="gmail-reader-subject"]', NEW_MAILS.pablo.subject)

    // With a panel open there is no alert (the mail still counts). Esc twice: the reader, then the view.
    // The click on the alert leaves the focus in the reader, and Esc from it puts the focus back on
    // the row of that mail, as in Electron.
    await eventually(
      () =>
        inPage(() => {
          const doc = (globalThis as unknown as { document: { activeElement: { closest(s: string): unknown } | null } }).document
          return doc.activeElement?.closest('[data-testid="gmail-reader"]') != null
        }),
      (inside) => inside,
      'the focus inside the reader',
    )
    await browser.keys('Escape')
    await $(PANEL).waitForDisplayed()
    await eventually(() => isFocused(messageOf(NEW_MAILS.pablo.id)), (focused) => focused, 'the focus on the row of the new mail')
    await browser.keys('Escape')
    await expectMode('expanded')
    const unreadBefore = server.hits['GET messages'] ?? 0
    server.addMail(NEW_MAILS.irene)
    await advanceClock(POLL_MS)
    await eventually(async () => server.hits['GET messages'] ?? 0, (n) => n > unreadBefore, 'the next poll')
    await browser.pause(1_000)
    await expectMode('expanded')
    expect(await count(ALERT)).toBe(0)
    // The pointer (left on the capsule by the click) leaves it, or the capsule would stay in compact.
    await pointerToCorner()
    await backToPeek()
    await whileHovered(() => expectMetric('6 correos sin leer').then(() => undefined))
    expect(await count(ALERT)).toBe(0)

    expect(server.violations).toEqual([])
    expectCleanLogs(server)
  })

  it('new mail alerts over a capsule hidden by the user ("Ocultar"), even after a long hidden stretch, then hides again', async () => {
    const server = fake!
    await signedIn(server)
    // GAP: the Control Center stays open (Electron closes it here).
    await expectMode('peek')

    // The notch's own "Ocultar" (the user-hide path): the window leaves the screen.
    await expandPanel()
    await $('button[aria-label="Ocultar"]').click()
    await capsule().waitForExist({ reverse: true })
    await eventually(notchWindowVisible, (visible) => !visible, 'the notch window hidden')

    // Gmail keeps polling while hidden: a long hidden stretch is no new baseline (the reported bug).
    const pollsBefore = server.hits['GET messages'] ?? 0
    await advanceClock(10 * POLL_MS)
    await eventually(async () => server.hits['GET messages'] ?? 0, (n) => n > pollsBefore, 'a poll while hidden')
    expect(await count('[data-testid="notch-capsule"]')).toBe(0)
    server.addMail(NEW_MAILS.rosa)
    await advanceClock(POLL_MS)

    // The alert shows over the hidden capsule: the window comes back (without focus) for ~6 s.
    await expectMode('alert')
    await expectText(ALERT, `${NEW_MAILS.rosa.sender} · ${NEW_MAILS.rosa.subject}`)
    expect(await notchWindowVisible()).toBe(true)
    await capsule().waitForExist({ reverse: true, timeout: 12_000 })
    await eventually(notchWindowVisible, (visible) => !visible, 'the notch window hidden again')

    // Shown again by the user: the count includes the new mail.
    await expandPanel()
    await backToPeek()
    await whileHovered(() => expectMetric('4 correos sin leer').then(() => undefined))

    expect(server.violations).toEqual([])
    expectCleanLogs(server)
  })

  it('a session without the full mail permission asks to sign in again for it', async () => {
    const server = fake!
    await start(server, { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET })
    await openGmailPage()

    // The consent asked for https://mail.google.com/ but Google granted only gmail.readonly: refused.
    server.grantReadonlyScope = true
    await signInThroughBrowser(server, 'expired')
    await expectTextContaining('[data-testid="gmail-scope"]', 'Vuelve a iniciar sesión para conceder el nuevo permiso')
    await expect(byTestId('gmail-scope-denied')).toBeDisplayed()
    expect(await signInButton().isEnabled()).toBe(true)
    await useWindow('notch')
    await whileHovered(() => expectMetric(null).then(() => undefined))
    // That token was never used.
    expect(server.hits['GET messages']).toBeUndefined()
    expect(server.hits['GET profile']).toBeUndefined()

    // Granted in full: the session works.
    server.grantReadonlyScope = false
    await signInThroughBrowser(server)
    await expectCount('[data-testid="gmail-scope"]', 0)
    await useWindow('notch')
    await whileHovered(() => expectMetric('3 correos sin leer').then(() => undefined))

    // A session whose refresh comes back with only gmail.readonly (a milestone-1 grant): once the
    // access token expires (test clock past its hour), the refresh is refused and the user is asked again.
    server.grantReadonlyScope = true
    const refreshes = server.hits['POST /token:refresh_token'] ?? 0
    await advanceClock(3_600_000)
    await useWindow('control-center')
    await expectAttribute(SESSION, 'data-status', 'expired')
    await expectTextContaining('[data-testid="gmail-scope"]', 'Vuelve a iniciar sesión para conceder el nuevo permiso')
    expect(server.hits['POST /token:refresh_token']).toBe(refreshes + 1)
    await useWindow('notch')
    await whileHovered(() => expectMetric(null).then(() => undefined))
    await openGmailView()
    // The notch names the missing permission too, with a way to the Control Center's Gmail page.
    await expectAttribute(STATUS, 'data-notice', 'scope')
    await expectTextContaining(STATUS, 'Vuelve a iniciar sesión para conceder el nuevo permiso.')
    await expect($(STATUS).$('[data-testid="gmail-open-control-center"]')).toBeDisplayed()

    expect(server.violations).toEqual([])
    expectCleanLogs(server)
  })

  it('row actions show on hover or keyboard focus only: a mouse click or programmatic focus never pins them', async () => {
    const server = fake!
    await signedIn(server)
    await openGmailView()
    await expectCount(ROWS, 5)
    const [ana, builds] = FAKE_MESSAGES
    const hidden = (id: string) => eventually(() => overlayOpacity(id), (o) => o === '0', `the actions of ${id} hidden`)
    const shown = (id: string) => eventually(() => overlayOpacity(id), (o) => o === '1', `the actions of ${id} shown`)

    // Plain hover: shown while hovering, hidden after.
    await $(rowOf(ana!.id)).moveTo()
    await shown(ana!.id)
    await pointerToCorner()
    await hidden(ana!.id)

    // Click opens the reader; the mouse-driven Back focuses the row programmatically. Moving over another
    // row then away must leave the first row's actions hidden (the pointer never made focus visible).
    await $(messageOf(ana!.id)).click()
    await expectReaderReady()
    await byTestId('gmail-reader-back').click()
    await expectCount(READER, 0)
    await eventually(() => isFocused(messageOf(ana!.id)), (focused) => focused, 'the focus back on the first row')
    await $(rowOf(builds!.id)).moveTo()
    await shown(builds!.id)
    await pointerToCorner()
    await hidden(ana!.id)
    await hidden(builds!.id)

    // A row left holding focus after a mouse click on its Mark as read / Delete stays hidden off-hover.
    await $(rowOf(ana!.id)).moveTo()
    await $(`${rowOf(ana!.id)} [data-testid="gmail-row-mark-read"]`).click()
    await expectCount(`${rowOf(ana!.id)} [data-testid="gmail-row-mark-read"]`, 0)
    await pointerToCorner()
    await hidden(ana!.id)

    // Keyboard: Tab focus reveals the actions with no hover.
    await focus(ROWS)
    await browser.keys('Tab')
    await browser.keys('Tab')
    expect(await overlayOpacity('focused')).not.toBeNull()
    await shown('focused')
    await browser.keys('Tab')
    await browser.keys('Tab')
    await shown('focused')
    expect(server.violations).toEqual([])
  })
})
