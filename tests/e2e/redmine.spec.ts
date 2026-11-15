import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import type { RedmineState } from '../../src/shared/redmine/schema'
import {
  FAKE_REDMINE_ACCOUNT,
  FAKE_REDMINE_KEY,
  FAKE_REDMINE_ORIGIN,
  REDMINE_ISSUES,
  REDMINE_LOG_COMMENT,
  SEEDED_TODAY_HOURS,
  SENSITIVE_DATA,
  expectedSeededSummary,
  localDay,
  startFakeRedmine,
  type FakeRedmine,
} from './fixtures/fake-redmine'
import { present, whileHovered } from './pointer'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }
/** Where the replaced `shell.openExternal` keeps the URLs main asked to open. */
type OpenedHost = { __notchOpened?: string[] }
type TestClockHost = { __notchTestClock: { advance: (ms: number) => Promise<void> } }
/** The DOM element as the page sees it (the node typings only know `SVGElement | HTMLElement`). */
type Attributed = { getAttribute: (name: string) => string | null }

/** The 5 min rhythm of today's hours and the assigned issues. */
const TICK_MS = 300_000

let userData: string
let launched: ElectronApplication | undefined
let fake: FakeRedmine | undefined

/** Settings v7: Redmine not connected yet, target 8 h, the end-of-day alert at 18:00 (silent). */
const writeSettings = (): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 7,
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
      gmail: { clientId: '', clientSecret: '', alerts: { enabled: true, hideContent: false, sound: false } },
      codeReview: { gitlabUrl: '', alerts: { github: { enabled: true, sound: false }, gitlab: { enabled: true, sound: false } } },
      redmine: { url: '', dailyTargetHours: 8, endOfDay: { enabled: true, time: '18:00', sound: false } },
    }),
    'utf8',
  )
}

const launch = async (server: FakeRedmine): Promise<{ app: ElectronApplication; notch: Page }> => {
  writeSettings()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Dev-only clock: moving it forward fires the 5 min Redmine query and the end-of-day check at once.
  env['NOTCH_TEST_CLOCK'] = '1'
  // Stay isolated from an installed notch and from the real ~/.claude/settings.json.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  // The Redmine API is the local fake (settings still hold the https URL the user typed).
  env['NOTCH_REDMINE_BASE_URL'] = server.base
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  // Never open the real browser: keep the URLs main asks to open.
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

/** Moves the dev-only test clock: a Redmine query that falls due runs now, and the end-of-day check runs. */
const advance = (app: ElectronApplication, ms: number) =>
  app.evaluate(async (_electron, delta) => {
    await (globalThis as unknown as TestClockHost).__notchTestClock.advance(delta)
  }, ms)

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')
const setLanguage = async (notch: Page, language: 'es' | 'en') => {
  await notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)
  await expect.poll(() => notch.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe(language)
}
const request = (notch: Page, intent: 'expand' | 'dismiss') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: value }), intent)

/** Main's Redmine state, as the notch reads it. */
const redmineState = async (notch: Page): Promise<RedmineState> => {
  const result = await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.redmine.getState())
  if (!result.ok) throw new Error('redmine:get-state failed')
  return result.data
}

const openControlCenter = async (app: ElectronApplication, notch: Page): Promise<Page> => {
  const opened = app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter({ page: 'redmine' }))
  const cc = await opened
  await cc.waitForLoadState('domcontentloaded')
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  await expect(cc.getByTestId('redmine-page')).toBeVisible()
  return cc
}

const connection = (cc: Page) => cc.getByTestId('redmine-connection')
const ccStatus = (cc: Page) => cc.getByTestId('redmine-status')

/** "Comprobar y guardar" with a server URL and a key. */
const saveKey = async (cc: Page, url: string, key: string): Promise<void> => {
  await connection(cc).getByLabel('URL de Redmine').fill(url)
  const field = connection(cc).getByLabel('Clave de acceso API')
  await field.fill(key)
  await expect(field).toHaveAttribute('type', 'password')
  await connection(cc).getByRole('button', { name: 'Comprobar y guardar' }).click()
}

/** Every input value of a window: a saved key must not linger in any of them. */
const inputValues = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    type Doc = { querySelectorAll: (selector: string) => Iterable<{ value: string }> }
    return [...(globalThis as unknown as { document: Doc }).document.querySelectorAll('input, textarea')].map((el) => el.value)
  })

const expectNoKeyInDom = async (page: Page): Promise<void> => {
  expect(await page.content(), 'key in the markup').not.toContain(FAKE_REDMINE_KEY)
  expect((await inputValues(page)).join('\n'), 'key in a field').not.toContain(FAKE_REDMINE_KEY)
}

/** Launch and connect from the Control Center; the capsule shows today's seeded hours. */
const connected = async (server: FakeRedmine): Promise<{ app: ElectronApplication; notch: Page; cc: Page }> => {
  const { app, notch } = await launch(server)
  const cc = await openControlCenter(app, notch)
  await saveKey(cc, FAKE_REDMINE_ORIGIN, FAKE_REDMINE_KEY)
  await expect(ccStatus(cc).locator('span')).toHaveText(`Conectado como ${FAKE_REDMINE_ACCOUNT}`)
  await whileHovered(notch, () => expect(present(notch, 'metric-redmine')).toHaveAttribute('aria-label', '2,5 h imputadas hoy en Redmine'))
  return { app, notch, cc }
}

const openRedmineView = async (notch: Page): Promise<void> => {
  await request(notch, 'expand')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  await notch.getByTestId('integration-redmine').click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'redmine')
  await expect(notch.getByTestId('redmine-panel')).toBeVisible()
}

const panel = (notch: Page) => notch.getByTestId('redmine-panel')
const rows = (notch: Page): Locator => notch.getByTestId('redmine-issue')
const rowIds = (notch: Page): Promise<number[]> =>
  notch.locator('[data-issue-id]:has([data-testid="redmine-issue"])').evaluateAll((els) => els.map((el) => Number((el as unknown as Attributed).getAttribute('data-issue-id'))))
const row = (notch: Page, id: number): Locator => notch.locator(`[data-issue-id="${id}"]`).getByTestId('redmine-issue')
const summaryCell = (notch: Page, column: 'today' | 'week' | 'monthTotal') => notch.getByTestId('redmine-summary').locator(`td[data-column="${column}"]`)
/** "6,5 h" as the Spanish summary writes hours. */
const hoursEs = (hours: number): string => `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(hours)} h`

const openDetail = async (notch: Page, id: number): Promise<Locator> => {
  await row(notch, id).click()
  const detail = notch.getByTestId('redmine-detail')
  await expect(detail).toHaveAttribute('data-issue-id', String(id))
  // Loaded: the status select and the log form are there.
  await expect(detail.getByTestId('redmine-detail-status')).toBeVisible()
  await expect(detail.getByTestId('redmine-log-submit')).toBeVisible()
  return detail
}

/** Every log line main wrote so far. */
const readLogs = (): string =>
  readdirSync(join(userData, 'logs'))
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(userData, 'logs', name), 'utf8'))
    .join('\n')

/** No key, subject, project, comment, account or server in the log, nor the key in plain text in userData. */
const expectCleanLogs = (): void => {
  const logs = readLogs()
  expect(logs).toContain('redmine') // the integration did log (states and counts)
  for (const piece of SENSITIVE_DATA) expect(logs, 'redmine data in the log').not.toContain(piece)
  for (const name of readdirSync(userData)) {
    const file = join(userData, name)
    if (!statSync(file).isFile()) continue
    expect(readFileSync(file).toString('latin1'), `plain key in ${name}`).not.toContain(FAKE_REDMINE_KEY)
  }
}

const screenshot = async (page: Page, name: string): Promise<void> => {
  await settle(page)
  await page.screenshot({ path: `test-results/${name}` })
}

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-redmine-'))
  fake = await startFakeRedmine()
})

test.afterEach(async () => {
  // A failed test must not leave Electron holding the temp profile, nor the fake server listening.
  await launched?.close().catch(() => undefined)
  launched = undefined
  await fake?.close().catch(() => undefined)
  fake = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('connect in Control Center, today’s hours in the capsule, the tile opens the view: search, status, estimate and log time; a 403 stays inline', async () => {
  test.setTimeout(120_000)
  const server = fake!
  const { app, notch } = await launch(server)
  const cc = await openControlCenter(app, notch)
  await expect(ccStatus(cc)).toHaveAttribute('data-status', 'unconfigured')
  // Nothing configured: nothing is asked of Redmine, no block in the capsule.
  expect(server.requests.count).toBe(0)
  await whileHovered(notch, () => expect(present(notch, 'metric-redmine')).toHaveCount(0))

  // A plain-http server is refused before anything is sent.
  await saveKey(cc, 'http://redmine.example.test', FAKE_REDMINE_KEY)
  await expect(cc.getByTestId('redmine-error')).toHaveText('Revisa la URL: debe empezar por https://, sin usuario, ? ni #, y apuntar a tu Redmine')
  expect(server.requests.count).toBe(0)
  // A wrong key: Redmine answers 401 and nothing is saved.
  await saveKey(cc, FAKE_REDMINE_ORIGIN, 'clave-que-no-vale-e2e')
  await expect(cc.getByTestId('redmine-error')).toHaveText('Clave no válida o API REST desactivada')
  await expect(ccStatus(cc)).toHaveAttribute('data-status', 'unconfigured')
  expect(server.hits['401']).toBe(1)
  // The right key: checked against the API, the account shows, the field is emptied, the URL saved.
  await saveKey(cc, FAKE_REDMINE_ORIGIN, FAKE_REDMINE_KEY)
  await expect(ccStatus(cc).locator('span')).toHaveText(`Conectado como ${FAKE_REDMINE_ACCOUNT}`)
  await expect(cc.getByTestId('redmine-error')).toHaveCount(0)
  await expect(connection(cc).getByLabel('Clave de acceso API')).toHaveValue('')
  await expect.poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).redmine.url).toBe(FAKE_REDMINE_ORIGIN)
  await expectNoKeyInDom(cc)
  // The Control Center page (the window is Mica: give the capture the dark backdrop it has on screen).
  await cc.addStyleTag({ content: 'html, body { background: #0d0d0f !important }' })
  await cc.locator('main').evaluate((el) => (el as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 0))
  await screenshot(cc, 'redmine-control-center-es.png')

  // The capsule: today's hours, "2,5h" in ES and "2.5h" in EN.
  await whileHovered(notch, async () => {
    const block = present(notch, 'metric-redmine')
    await expect(block).toHaveAttribute('aria-label', '2,5 h imputadas hoy en Redmine')
    await expect(block).toContainText('2,5h')
    await screenshot(notch, 'redmine-capsule-es.png')
  })
  await setLanguage(notch, 'en')
  await whileHovered(notch, async () => {
    const block = present(notch, 'metric-redmine')
    await expect(block).toHaveAttribute('aria-label', '2.5 h logged today in Redmine')
    await expect(block).toContainText('2.5h')
    await screenshot(notch, 'redmine-capsule-en.png')
  })

  // The panel with its nine tiles, EN then ES.
  await request(notch, 'expand')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  await expect(notch.locator('[data-testid^="integration-"]:not([data-testid$="-badge"])')).toHaveCount(9)
  await notch.mouse.move(1, 1)
  await screenshot(notch, 'redmine-panel-9-tiles-en.png')
  await setLanguage(notch, 'es')
  await screenshot(notch, 'redmine-panel-9-tiles-es.png')

  // The tile opens the view: the summary (today, week, month) and the assigned issues, newest first.
  await notch.getByTestId('integration-redmine').click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'redmine')
  await expect(panel(notch)).toHaveAttribute('data-body', 'list')
  await expect(rows(notch)).toHaveCount(REDMINE_ISSUES.length)
  expect(await rowIds(notch)).toEqual(REDMINE_ISSUES.map((issue) => issue.id))
  await expect(row(notch, 4120).getByTestId('redmine-issue-subject')).toHaveText('Diseño de la pantalla de imputación')
  await expect(row(notch, 4120).getByTestId('redmine-issue-status')).toHaveText('Nueva')
  await expect(row(notch, 4120).getByTestId('redmine-issue-hours')).toHaveText('1,5/6 h')
  await expect(row(notch, 412).getByTestId('redmine-issue-hours')).toHaveText('3 h')
  await expect(row(notch, 4120).getByTestId('redmine-issue-project')).toHaveText('Portal Ejemplo')
  const seeded = expectedSeededSummary(new Date())
  await expect(notch.getByTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')
  await expect(summaryCell(notch, 'today')).toHaveText(hoursEs(seeded.today))
  await expect(summaryCell(notch, 'week')).toHaveText(hoursEs(seeded.week))
  await expect(summaryCell(notch, 'monthTotal')).toHaveText(hoursEs(seeded.month))
  await expect(notch.getByTestId('redmine-summary-target')).toHaveText('Jornada de 8 h')
  await panel(notch).locator('h2').hover()
  await screenshot(notch, 'redmine-view-list-es.png')

  // Search: case and accents ignored; a number (with or without #) is that exact id only.
  const search = notch.getByTestId('redmine-search')
  await search.fill('DISENO')
  await expect.poll(() => rowIds(notch)).toEqual([4120])
  await search.fill('nominas')
  await expect.poll(() => rowIds(notch)).toEqual([412, 2875])
  await search.fill('#412')
  await expect.poll(() => rowIds(notch)).toEqual([412])
  await search.fill('4012')
  await expect.poll(() => rowIds(notch)).toEqual([4012])
  await search.fill('nada parecido')
  await expect(notch.getByTestId('redmine-no-match')).toHaveText('Ninguna tarea coincide')
  // Esc clears the search first (the view stays open).
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(rows(notch)).toHaveCount(REDMINE_ISSUES.length)

  // The detail of #4012: its status (the allowed ones) and its estimate.
  let detail = await openDetail(notch, 4012)
  await expect(panel(notch)).toHaveAttribute('data-body', 'detail')
  await expect(detail.getByTestId('redmine-detail-subject')).toHaveText('Revisar los permisos del informe mensual')
  const status = detail.getByTestId('redmine-detail-status')
  await expect(status).toHaveValue('2')
  expect(await status.locator('option').allTextContents()).toEqual(['Nueva', 'En curso', 'Resuelta'])
  await status.selectOption('3')
  await expect(detail.getByTestId('redmine-detail-task-done')).toHaveText('Guardado')
  await expect(status).toHaveValue('3')
  expect(server.issue(4012).statusId).toBe(3)
  const estimate = detail.getByTestId('redmine-detail-estimate')
  await expect(estimate).toHaveValue('2')
  await estimate.fill('3,5')
  await detail.getByTestId('redmine-detail-estimate-save').click()
  await expect(detail.getByTestId('redmine-detail-task-done')).toHaveText('Guardado')
  expect(server.issue(4012).estimatedHours).toBe(3.5)
  await expect(estimate).toHaveValue('3,5')

  // Log time: today by default, Redmine's default activity preselected.
  await expect(detail.getByTestId('redmine-log-date')).toHaveValue(localDay(new Date()))
  await expect(detail.getByTestId('redmine-log-activity')).toHaveValue('9')
  await detail.getByTestId('redmine-log-hours').fill('1,5')
  await detail.getByTestId('redmine-log-comment').fill(REDMINE_LOG_COMMENT)
  await panel(notch).locator('h2').hover()
  await screenshot(notch, 'redmine-view-log-form-es.png')
  await detail.getByTestId('redmine-log-submit').click()
  await expect(detail.getByTestId('redmine-log-done')).toHaveText('1,5 h imputadas')
  await expect(detail.getByTestId('redmine-log-hours')).toHaveValue('')
  await expect(detail.getByTestId('redmine-detail-spent')).toHaveText('1,5 h imputadas')
  const logged = server.entries.at(-1)!
  expect(logged).toMatchObject({ issueId: 4012, spentOn: localDay(new Date()), hours: 1.5, activityId: 9, comments: REDMINE_LOG_COMMENT })
  await screenshot(notch, 'redmine-view-detail-es.png')

  // "Abrir en Redmine": the configured https server, never the fake's address.
  await detail.getByTestId('redmine-detail-open').click()
  await expect.poll(() => openedUrls(app)).toEqual([`${FAKE_REDMINE_ORIGIN}/issues/4012`])

  // Back to the list: #4012 moved to the top with its new status and hours; the summary went up.
  await notch.getByTestId('redmine-back').click()
  await expect(panel(notch)).toHaveAttribute('data-body', 'list')
  await expect.poll(() => rowIds(notch)).toEqual([4012, 4120, 412, 3301, 2875])
  await expect(row(notch, 4012).getByTestId('redmine-issue-status')).toHaveText('Resuelta')
  await expect(row(notch, 4012).getByTestId('redmine-issue-hours')).toHaveText('1,5/3,5 h')
  await expect(summaryCell(notch, 'today')).toHaveText(hoursEs(seeded.today + 1.5))
  await expect(summaryCell(notch, 'week')).toHaveText(hoursEs(seeded.week + 1.5))
  await expect(summaryCell(notch, 'monthTotal')).toHaveText(hoursEs(seeded.month + 1.5))

  // A 403 on an issue the user may not touch: the error stays in the form, the session stays connected.
  server.forbiddenIssues.add(2875)
  const entriesBefore = server.entries.length
  detail = await openDetail(notch, 2875)
  await detail.getByTestId('redmine-log-hours').fill('1')
  await detail.getByTestId('redmine-log-submit').click()
  await expect(detail.getByTestId('redmine-log-error')).toHaveText('Redmine no te deja hacer este cambio')
  await expect(detail.getByTestId('redmine-log-retry')).toHaveCount(0)
  await expect(detail.getByTestId('redmine-log-hours')).toHaveValue('1')
  await detail.getByTestId('redmine-detail-status').selectOption('1')
  await expect(detail.getByTestId('redmine-detail-task-error')).toHaveText('Redmine no te deja hacer este cambio')
  await expect(detail.getByTestId('redmine-detail-status')).toHaveValue('3')
  await panel(notch).locator('h2').hover()
  await screenshot(notch, 'redmine-view-403-es.png')
  expect(server.hits['403']).toBe(2)
  expect(server.entries.length).toBe(entriesBefore)
  expect(server.issue(2875).statusId).toBe(3)
  expect((await redmineState(notch)).status).toBe('ok')
  await expect(ccStatus(cc).locator('span')).toHaveText(`Conectado como ${FAKE_REDMINE_ACCOUNT}`)

  // Esc closes the detail (back to its row), then the view; the capsule shows today's new total.
  await detail.focus()
  await notch.keyboard.press('Escape')
  await expect(panel(notch)).toHaveAttribute('data-body', 'list')
  await expect(row(notch, 2875)).toBeFocused()
  await notch.keyboard.press('Escape')
  await expect(panel(notch)).toHaveCount(0)
  await notch.mouse.move(1, 1)
  await request(notch, 'dismiss')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'peek')
  await whileHovered(notch, async () => {
    await expect(present(notch, 'metric-redmine')).toHaveAttribute('aria-label', `${hoursEs(SEEDED_TODAY_HOURS + 1.5)} imputadas hoy en Redmine`)
    await expect(present(notch, 'metric-redmine')).toContainText('4h')
  })

  await expectNoKeyInDom(notch)
  await expectNoKeyInDom(cc)
  expect(server.violations).toEqual([])
  expect(server.hits['update']).toBe(3)
  expect(server.hits['log']).toBe(2)
  expectCleanLogs()
})

test('a key Redmine later rejects (401) asks to check the key, hides the capsule block and stops querying', async () => {
  const server = fake!
  const { app, notch, cc } = await connected(server)
  await openRedmineView(notch)
  await expect(rows(notch)).toHaveCount(REDMINE_ISSUES.length)

  // The key is revoked (or the REST API turned off); the next 5 min query finds out.
  server.unauthorized = true
  await advance(app, TICK_MS)
  await expect(ccStatus(cc)).toHaveAttribute('data-status', 'auth-error')
  await expect(ccStatus(cc)).toContainText('Revisa la clave: ya no es válida o la API REST está desactivada.')
  const notice = panel(notch).getByTestId('redmine-status')
  await expect(notice).toHaveAttribute('data-notice', 'auth')
  await expect(notice).toContainText('Revisa la clave API en Control Center')
  await expect(rows(notch)).toHaveCount(0)
  await expect(notch.getByTestId('redmine-open-control-center')).toBeVisible()

  // No more requests: not on the rhythm, not on a refresh.
  const before = server.requests.count
  await advance(app, TICK_MS)
  await advance(app, TICK_MS)
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.redmine.refresh())
  await notch.waitForTimeout(1_000)
  expect(server.requests.count).toBe(before)

  // The capsule has no Redmine block left.
  await panel(notch).focus()
  await notch.keyboard.press('Escape')
  await notch.mouse.move(1, 1)
  await request(notch, 'dismiss')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'peek')
  await whileHovered(notch, () => expect(present(notch, 'metric-redmine')).toHaveCount(0))

  // A new valid key brings it back.
  server.unauthorized = false
  await saveKey(cc, FAKE_REDMINE_ORIGIN, FAKE_REDMINE_KEY)
  await expect(ccStatus(cc).locator('span')).toHaveText(`Conectado como ${FAKE_REDMINE_ACCOUNT}`)
  await whileHovered(notch, () => expect(present(notch, 'metric-redmine')).toHaveAttribute('aria-label', '2,5 h imputadas hoy en Redmine'))

  expect(server.violations).toEqual([])
  expectCleanLogs()
})

/** The next Monday at 18:00:30 local that is at least two minutes ahead of `now`. */
const nextMondayAlertTime = (now: Date): Date => {
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 18, 0, 30)
    if (day.getDay() === 1 && day.getTime() - now.getTime() >= 120_000) return day
  }
  throw new Error('no Monday within a week')
}

test('the end-of-day alert: on Monday at 18:00 with fewer hours than the target, once; a click opens the view', async () => {
  const server = fake!
  const { app, notch, cc } = await connected(server)
  await cc.close()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'peek')
  // Today's hours are loaded before the clock moves (the check needs a reading for the day).
  expect((await redmineState(notch)).todayHours).toBe(SEEDED_TODAY_HOURS)

  // The test clock jumps to Monday 18:00:30 (inside the alert's 1 h window). The 5 min query falls due
  // on the way and reads that day's hours; the check that runs with the jump has no reading for the new
  // day yet, so it waits for one.
  const realNow = new Date()
  const alertAt = nextMondayAlertTime(realNow)
  const sameDay = localDay(alertAt) === localDay(realNow)
  await advance(app, alertAt.getTime() - Date.now())
  await expect.poll(async () => (await redmineState(notch)).updatedAt ?? 0).toBeGreaterThanOrEqual(alertAt.getTime() - 60_000)
  // With that day's hours read, the next check alerts (or the 60 s safety interval already did).
  await advance(app, 0)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  const alert = notch.getByTestId('redmine-alert')
  const hours = sameDay ? '2,5' : '0'
  await expect(alert).toHaveAttribute('aria-label', `Llevas ${hours} h de 8 h hoy`)
  await expect(alert).toHaveText(`Llevas ${hours} h de 8 h hoy`)
  await expect(alert).toHaveAttribute('aria-live', 'polite')
  await screenshot(notch, 'redmine-alert-es.png')

  // A click opens the Redmine view.
  await alert.click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'redmine')
  await expect(panel(notch)).toBeVisible()
  await panel(notch).focus()
  await notch.keyboard.press('Escape')
  await expect(panel(notch)).toHaveCount(0)
  await notch.mouse.move(1, 1)
  await request(notch, 'dismiss')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'peek')

  // Once a day: later checks the same evening alert nothing.
  await advance(app, 60_000)
  await advance(app, TICK_MS)
  await notch.waitForTimeout(1_000)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'peek')
  await expect(notch.getByTestId('redmine-alert')).toHaveCount(0)

  expect(server.violations).toEqual([])
  expectCleanLogs()
})
