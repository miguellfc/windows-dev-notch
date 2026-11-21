/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Redmine, ported from 0.1.0's Electron e2e redmine.spec.ts. Redmine's REST API is the strict fake
// of tests/e2e-tauri/fixtures/fake-redmine.ts, started in this process on 127.0.0.1 and passed per launch
// as `--e2e-env-NOTCH_REDMINE_BASE_URL` (the settings still hold the https URL the user typed). Every
// test asserts the fake saw no protocol violation. URLs main would open are recorded
// (`NOTCH_OPEN_URL_LOG=1`, read with `__e2e:opened-urls`), never opened: the recorder is checked to
// be on before anything is clicked. The 5 min query and the end-of-day check move with
// `__e2e:advance-clock`; the query it fires runs after it answers, so its effects are polled with
// `eventually`.
//
// Hover is `pointer()` (`__e2e:pointer`), as in the other Tauri specs.
// GAP: the Electron spec closes the Control Center (`cc.close()`, test 3); here it stays open (no
// close channel, as in claude.spec.ts and code-review.spec.ts) and WebDriver switches between the
// two webviews.
// GAP: screenshots (test-results/redmine-*.png) are not assertions and are left out, as in the other
// Tauri specs; so are the `hover()` / `mouse.move` calls that only placed the pointer for them.
// GAP: `expandPanel` retries a panel opening lost to a focus-loss dismiss (the known follow-up of
// code-review.spec.ts and docs/e2e.md, with the Control Center left open); every other
// failure to open fails at once.
// GAP: text checks read `textContent` with whitespace collapsed (Playwright's `toHaveText`);
// WebDriver's visible text would apply CSS text transforms.
// The 6 s end-of-day alert ends at 6 s of real time or when the test clock passes that point
// (the notch timers run over real time in the e2e build); the spec clicks it right away and does
// not move the clock while it is up.
// KNOWN DIVERGENCE (follow-up of part 4, not fixed in part 5): Rust (`chrono::Local`) takes local
// days and times from Windows' time zone rules, while the WebView2 renderer (JS `Date`), Electron
// and this Node process use ICU's tz data. Where they disagree, main and renderer disagree on the
// local day for an hour a day. Harness measure, as in code-review.spec.ts: the worker runs on
// Windows' fixed offset (helpers.ts `alignZoneWithWindows`, here over the week ahead the alert test
// jumps into), so the fake seeds and checks its days with the app's days, and the expected data is
// built from Windows' day. Only in the known divergence hour (`appDays`: the worker had to be
// aligned, the renderer's day is ICU's day in the worker's original zone, and it is exactly one day
// from Windows') does the spec accept the renderer's default log date being the renderer's today
// rather than Windows' (logged). The time is then logged on the earlier of the two days (main
// refuses a later one as a future date), and the expected summary and capsule hours follow the day
// actually logged. Any other difference between the two days fails.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  FAKE_REDMINE_ACCOUNT,
  FAKE_REDMINE_KEY,
  FAKE_REDMINE_ORIGIN,
  REDMINE_OUTSIDE_ISSUE,
  REDMINE_LOG_COMMENT,
  SEEDED_TODAY_HOURS,
  SENSITIVE_DATA,
  expectedSeededSummary,
  localDay,
  startFakeRedmine,
  type FakeRedmine,
} from './fixtures/fake-redmine'
import { CAPSULE_BLOCK } from '../../src/shared/notch/geometry'
import type { RedmineState } from '../../src/shared/redmine/schema'
import {
  capsuleBox,
  clickCard,
  DEFAULT_ALERTS,
  advanceClock,
  alignZoneWithWindows,
  dataDir,
  eventually,
  fillValue,
  inPage,
  labelledField,
  launch,
  openControlCenter,
  openedUrls,
  pageLang,
  pageTextAndValues,
  pointer,
  present,
  quitApp,
  readLogs,
  requestIntent,
  seededSettings,
  setLanguage,
  useWindow,
  whileHovered,
} from './helpers'

/** The 5 min rhythm of today's hours and the assigned issues. */
const TICK_MS = 300_000

let fake: FakeRedmine | undefined

const capsule = () => $('[data-testid="notch-capsule"]')
const byTestId = (id: string) => $(`[data-testid="${id}"]`)
const mode = () => capsule().getAttribute('data-mode')
const expectMode = (value: string, timeout?: number) => eventually(mode, (current) => current === value, `data-mode=${value}`, timeout)

/** Settings: Redmine not connected yet, target 8 h, the end-of-day alert at 18:00 (silent). */
const settings = () => ({
  ...seededSettings(DEFAULT_ALERTS),
  redmine: { url: '', dailyTargetHours: 8, endOfDay: { enabled: true, time: '18:00', sound: false } },
})

/** A fresh app on the fake Redmine, URLs recorded instead of opened. */
async function start(server: FakeRedmine): Promise<void> {
  // A malformed base turns the override off (the app would talk to the configured server): only
  // ever the fake's loopback origin.
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(server.base)) throw new Error(`Unexpected fake origin ${server.base}`)
  await launch({
    fresh: true,
    env: { NOTCH_REDMINE_BASE_URL: server.base, NOTCH_OPEN_URL_LOG: '1' },
    files: { 'settings.json': settings() },
  })
  // The recorder must be on before anything is clicked (UNAVAILABLE otherwise): never a real browser.
  expect(await openedUrls()).toEqual([])
}

/** Opens the Control Center on its Redmine page; WebDriver stays on it. */
async function openRedminePage(): Promise<void> {
  await openControlCenter('redmine')
  await byTestId('redmine-page').waitForDisplayed()
}

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
const expectCount = (selector: string, n: number) => eventually(() => count(selector), (value) => value === n, `${n} × ${selector}`)

const CONNECTION = '[data-testid="redmine-connection"]'
const CC_STATUS = '[data-testid="redmine-status"]'
const CC_STATUS_TEXT = `${CC_STATUS} span`
const submitKey = () => $(CONNECTION).$('.//button[normalize-space()="Comprobar y guardar"]')

/** "Comprobar y guardar" with a server URL and a key (WebDriver on the Control Center). */
async function saveKey(url: string, key: string): Promise<void> {
  await fillValue(await labelledField(CONNECTION, 'URL de Redmine'), url)
  const field = await labelledField(CONNECTION, 'Clave de acceso API')
  await fillValue(field, key)
  await expect($(field)).toHaveAttribute('type', 'password')
  await submitKey().click()
}

const expectConnected = () => expectText(CC_STATUS_TEXT, `Conectado como ${FAKE_REDMINE_ACCOUNT}`)

/** "5,5 h" / "5.5 h" as the summary and the labels write hours. */
const hoursIn = (language: 'es' | 'en', hours: number): string =>
  `${new Intl.NumberFormat(language === 'es' ? 'es-ES' : 'en-US', { maximumFractionDigits: 2 }).format(hours)} h`
/** The seeded hours of the month so far (today's and the 1st's), by the worker's aligned day. */
const seededMonth = (): number => expectedSeededSummary(new Date()).month
/** The capsule block's label for the month's hours. */
const monthMetric = (hours: number, language: 'es' | 'en' = 'es'): string =>
  language === 'es' ? `${hoursIn('es', hours)} imputadas este mes en Redmine` : `${hoursIn('en', hours)} logged this month in Redmine`

/** The capsule's Redmine block (the present copy): its aria-label, or null when absent. */
const redmineMetric = async (): Promise<string | null> => {
  const blocks = await $$(present('metric-redmine'))
  return blocks.length === 0 ? null : blocks[0]!.getAttribute('aria-label')
}
const expectMetric = (label: string | null) => eventually(redmineMetric, (value) => value === label, `the Redmine block ${label ?? 'absent'}`)

/** Main's Redmine state, as the notch reads it. */
async function redmineState(): Promise<RedmineState> {
  const result = await inPage(() =>
    (globalThis as unknown as { notch: { redmine: { getState(): Promise<{ ok: boolean; data?: unknown }> } } }).notch.redmine.getState(),
  )
  if (!result.ok) throw new Error('redmine:get-state failed')
  return result.data as RedmineState
}

/** The key never stays in the current window: not in the markup, not in any field's value. */
async function expectNoKeyInDom(): Promise<void> {
  const { html, values } = await pageTextAndValues()
  expect(html.includes(FAKE_REDMINE_KEY)).toBe(false)
  expect(values.join('\n').includes(FAKE_REDMINE_KEY)).toBe(false)
}

/** No key, subject, project, comment, account or server in the log, nor the key in plain text in the data folder. */
function expectCleanLogs(): void {
  const logs = readLogs()
  expect(logs).toContain('redmine') // the integration did log (states and counts)
  for (const piece of SENSITIVE_DATA) expect({ piece, inLog: logs.includes(piece) }).toEqual({ piece, inLog: false })
  for (const name of readdirSync(dataDir())) {
    const file = join(dataDir(), name)
    if (!statSync(file).isFile()) continue
    expect({ name, plainKey: readFileSync(file).toString('latin1').includes(FAKE_REDMINE_KEY) }).toEqual({ name, plainKey: false })
  }
}

const readSettingsFile = (): { redmine: { url: string } } => JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8')) as { redmine: { url: string } }

/** Launch and connect from the Control Center; the capsule shows the month's seeded hours. WebDriver ends on the notch. */
async function connected(server: FakeRedmine): Promise<void> {
  await start(server)
  await openRedminePage()
  await saveKey(FAKE_REDMINE_ORIGIN, FAKE_REDMINE_KEY)
  await expectConnected()
  await useWindow('notch')
  await whileHovered(() => expectMetric(monthMetric(seededMonth())).then(() => undefined))
}

/**
 * The Redmine block as WebView2 paints it (the present copy): its width plus the 10 px gap before
 * it must fit CAPSULE_BLOCK.redmine, whatever the hours (it reserves "744,75h").
 */
const redmineBlockWidth = (): Promise<number> =>
  inPage((selector: string) => {
    const el = (globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { width: number } } | null } }).document.querySelector(selector)
    return el ? el.getBoundingClientRect().width : -1
  }, present('metric-redmine'))

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

const PANEL = '[data-testid="redmine-panel"]'
const panel = () => $(PANEL)

async function openRedmineView(): Promise<void> {
  await expandPanel()
  await clickCard('integration-redmine')
  await expectMode('redmine')
  await panel().waitForDisplayed()
}

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

/**
 * Picks `value` in a `<select>` the way a user's choice reaches React (Playwright's
 * `selectOption`): the native value setter, then `input` and `change`.
 */
const selectValue = (selector: string, value: string): Promise<void> =>
  inPage(
    (sel: string, text: string) => {
      type Select = { dispatchEvent(event: unknown): boolean; focus(): void }
      const w = globalThis as unknown as {
        document: { querySelector(s: string): Select | null }
        HTMLSelectElement: { prototype: object }
        Event: new (type: string, init: Record<string, unknown>) => unknown
      }
      const el = w.document.querySelector(sel)
      if (!el) throw new Error(`No element ${sel}`)
      el.focus()
      Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')?.set?.call(el, text)
      el.dispatchEvent(new w.Event('input', { bubbles: true }))
      el.dispatchEvent(new w.Event('change', { bubbles: true }))
    },
    selector,
    value,
  )

const valueOf = (selector: string): Promise<string | null> =>
  inPage((sel: string) => (globalThis as unknown as { document: { querySelector(s: string): { value: string } | null } }).document.querySelector(sel)?.value ?? null, selector)
const expectValue = (selector: string, value: string) => eventually(() => valueOf(selector), (current) => current === value, `${selector} value "${value}"`)

const ROWS = '[data-testid="redmine-issue"]'
const row = (id: number) => `[data-issue-id="${id}"] [data-testid="redmine-issue"]`
const rowIds = (): Promise<number[]> =>
  inPage(() =>
    Array.from(
      (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getAttribute(name: string): string | null }> } }).document.querySelectorAll(
        '[data-issue-id]:has([data-testid="redmine-issue"])',
      ),
    ).map((el) => Number(el.getAttribute('data-issue-id'))),
  )
const expectRowIds = (ids: number[]) => eventually(rowIds, (current) => JSON.stringify(current) === JSON.stringify(ids), `rows ${JSON.stringify(ids)}`)
const summaryCell = (column: 'today' | 'week' | 'monthTotal') => `[data-testid="redmine-summary"] td[data-column="${column}"]`
/** "6,5 h" as the Spanish summary writes hours. */
const hoursEs = (hours: number): string => `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(hours)} h`

const DETAIL = '[data-testid="redmine-detail"]'
const SUMMARY_LINE = '[data-testid="redmine-summary-line"]'
/** "5,5H" as the one-line summary writes hours. */
const hoursLine = (hours: number): string => hoursEs(hours).replace(' h', 'H')
const inDetail = (id: string) => `${DETAIL} [data-testid="${id}"]`

const SEARCH = '[data-testid="redmine-search"]'

/** The detail takes the whole view: its header "← #id subject", and no search box, summary or Refresh. */
async function expectFullViewDetail(id: number, subject: string): Promise<void> {
  await expect(panel()).toHaveAttribute('data-body', 'detail')
  await expectText(inDetail('redmine-detail-id'), `#${id}`)
  await expectText(inDetail('redmine-detail-subject'), subject)
  await expectCount(inDetail('redmine-back'), 1)
  await expectCount(SEARCH, 0)
  await expectCount('[data-testid="redmine-summary"]', 0)
  await expectCount('[data-testid="redmine-refresh"]', 0)
}

/**
 * The way to a detail: its number in the search box gives one row, a click on it opens the detail,
 * which takes the whole view. Waits for the detail to load.
 */
async function openDetail(id: number): Promise<void> {
  await fillValue(SEARCH, String(id))
  await expectRowIds([id])
  await $(row(id)).click()
  await eventually(() => $(DETAIL).getAttribute('data-issue-id'), (value) => value === String(id), `the detail of #${id}`)
  // Loaded: the status select and the log form are there.
  await $(inDetail('redmine-detail-status')).waitForDisplayed()
  await $(inDetail('redmine-log-submit')).waitForDisplayed()
}

/** The worker's zone before `alignZoneWithWindows` (ICU's idea of the machine's zone), and the fixed zone it set, if any. */
let originalZone = ''
let alignedZone: string | null = null

/** `YYYY-MM-DD` of now in `timeZone` (ICU). */
const icuDay = (timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
const daysBetweenKeys = (a: string, b: string): number => {
  const utc = (key: string) => {
    const [y = 0, m = 1, d = 1] = key.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((utc(b) - utc(a)) / 86_400_000)
}

/**
 * Windows' local date (the app's Rust side; this worker runs on it after `alignZoneWithWindows`) and
 * the renderer's (its JS `Date`, ICU): `appDays` of code-review.spec.ts. They may differ ONLY in the
 * known divergence hour (aligned worker, the renderer's day is ICU's day in the original zone, one
 * day apart); any other difference fails here.
 */
async function appDays(): Promise<{ windows: string; renderer: string; divergent: boolean }> {
  const windows = localDay(new Date())
  const renderer = await inPage(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  if (renderer === windows) return { windows, renderer, divergent: false }
  const divergent = alignedZone !== null && renderer === icuDay(originalZone) && Math.abs(daysBetweenKeys(windows, renderer)) === 1
  expect({ windows, renderer, knownDivergenceHour: divergent }).toEqual({ windows, renderer, knownDivergenceHour: true })
  console.log(`Known tz-data divergence hour: the renderer's today (${renderer}) is not Windows' local date (${windows})`)
  return { windows, renderer, divergent }
}

/** `YYYY-MM-DD` of the Monday of the week of `key`. */
const mondayOf = (key: string): string => {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number)
  const day = new Date(y, m - 1, d)
  return localDay(new Date(y, m - 1, d - ((day.getDay() + 6) % 7)))
}

/** The next Monday at 18:00:30 local that is at least two minutes ahead of `now`. */
const nextMondayAlertTime = (now: Date): Date => {
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 18, 0, 30)
    if (day.getDay() === 1 && day.getTime() - now.getTime() >= 120_000) return day
  }
  throw new Error('no Monday within a week')
}

describe('Redmine (Tauri)', () => {
  before(() => {
    // The fake's local days must be the app's (Rust follows Windows' zone rules; see the KNOWN
    // DIVERGENCE note above). 9 days ahead: the alert test jumps to the next Monday.
    originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const zone = alignZoneWithWindows(9)
    alignedZone = zone
    if (zone) console.log(`Node's tz data disagrees with Windows' here: this worker runs on ${zone}, the offset Windows uses (known divergence)`)
  })

  beforeEach(async () => {
    fake = await startFakeRedmine()
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

  it('connect in Control Center, the month’s hours in the capsule and on the tile, the tile opens the view: search, status, estimate and log time; a 403 stays inline', async () => {
    const server = fake!
    await start(server)
    await openRedminePage()
    await expect(byTestId('redmine-status')).toHaveAttribute('data-status', 'unconfigured')
    // Nothing configured: nothing is asked of Redmine, no block in the capsule.
    expect(server.requests.count).toBe(0)
    await useWindow('notch')
    await whileHovered(async () => {
      expect(await redmineMetric()).toBeNull()
    })

    // A plain-http server is refused before anything is sent.
    await useWindow('control-center')
    await saveKey('http://redmine.example.test', FAKE_REDMINE_KEY)
    await expectText('[data-testid="redmine-error"]', 'Revisa la URL: debe empezar por https://, sin usuario, ? ni #, y apuntar a tu Redmine')
    expect(server.requests.count).toBe(0)
    // A wrong key: Redmine answers 401 and nothing is saved.
    await saveKey(FAKE_REDMINE_ORIGIN, 'clave-que-no-vale-e2e')
    await expectText('[data-testid="redmine-error"]', 'Clave no válida o API REST desactivada')
    await expect(byTestId('redmine-status')).toHaveAttribute('data-status', 'unconfigured')
    expect(server.hits['401']).toBe(1)
    // The right key: checked against the API, the account shows, the field is emptied, the URL saved.
    await saveKey(FAKE_REDMINE_ORIGIN, FAKE_REDMINE_KEY)
    await expectConnected()
    await expectCount('[data-testid="redmine-error"]', 0)
    await expectValue(await labelledField(CONNECTION, 'Clave de acceso API'), '')
    await eventually(async () => readSettingsFile().redmine.url, (url) => url === FAKE_REDMINE_ORIGIN, 'the Redmine URL in settings.json')
    await expectNoKeyInDom()

    // The capsule: the month's hours so far (today's and the 1st's), "5,5h" in ES and "5.5h" in EN,
    // in a block as wide as CAPSULE_BLOCK.redmine reserves.
    const month = seededMonth()
    await useWindow('notch')
    await whileHovered(async () => {
      await expectMetric(monthMetric(month))
      await expectTextContaining(present('metric-redmine'), hoursIn('es', month).replace(' ', ''))
      const width = await redmineBlockWidth()
      console.log(`Redmine capsule block (es): ${width} px + 10 px gap`)
      expect(width + 10).toBeLessThanOrEqual(CAPSULE_BLOCK.redmine + 0.5)
      expect(width + 10).toBeGreaterThan(CAPSULE_BLOCK.redmine - 1)
    })
    // `<html lang>` follows the language only while a translated view is mounted (app.spec.ts
    // setLanguage), so the English labels below are what is waited for.
    await setLanguage('en')
    await whileHovered(async () => {
      await expectMetric(monthMetric(month, 'en'))
      await expectTextContaining(present('metric-redmine'), hoursIn('en', month).replace(' ', ''))
      const width = await redmineBlockWidth()
      console.log(`Redmine capsule block (en): ${width} px + 10 px gap`)
      expect(width + 10).toBeLessThanOrEqual(CAPSULE_BLOCK.redmine + 0.5)
    })

    // The panel with its eight tiles, EN then ES.
    await expandPanel()
    await expectCount('[data-testid^="integration-"]:not([data-testid$="-badge"]):not([data-testid$="-label"])', 8)
    await setLanguage('es')
    await eventually(pageLang, (lang) => lang === 'es', 'lang=es (the panel is mounted)')

    // The tile: the month's squares (today ringed, coloured by its 2,5 h of the 8 h target, from the
    // summary main keeps with every poll, the view never opened), today's hours and the month's.
    const tile = '[data-testid="integration-redmine"]'
    await expectTextContaining(`${tile} [data-testid="redmine-card-today"]`, hoursIn('es', SEEDED_TODAY_HOURS).replace(' ', ''))
    await expectTextContaining(`${tile} [data-testid="redmine-card-today"]`, 'de 8 h hoy')
    await expectTextContaining(`${tile} [data-testid="redmine-card-month"]`, hoursIn('es', month).replace(' ', ''))
    await expectTextContaining(`${tile} [data-testid="redmine-card-month"]`, 'en ')
    await eventually(
      () => $(`${tile} [data-today="true"]`).getAttribute('data-level'),
      (level) => level === '2',
      "today's square at level 2 (2,5 h of 8 h)",
    )

    // The tile opens the view. At rest: the summary (today, week, month) and the search box, no list.
    await clickCard('integration-redmine')
    await expectMode('redmine')
    await expect(panel()).toHaveAttribute('data-body', 'list')
    await expectCount(ROWS, 0)
    // Expected data from Windows' day (the app's, and the aligned worker's); see appDays.
    const days = await appDays()
    const seeded = expectedSeededSummary(new Date())
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')
    await expectText(summaryCell('today'), hoursEs(seeded.today))
    await expectText(summaryCell('week'), hoursEs(seeded.week))
    await expectText(summaryCell('monthTotal'), hoursEs(seeded.month))
    await expectText('[data-testid="redmine-summary-target"]', 'Jornada de 8 h')

    // Search: case and accents ignored. Several matches are rows (newest first) with their data.
    const search = SEARCH
    await fillValue(search, 'portal')
    await expectRowIds([4120, 4012])
    await expectText(`[data-issue-id="4120"] [data-testid="redmine-issue-subject"]`, 'Diseño de la pantalla de imputación')
    await expectText(`[data-issue-id="4120"] [data-testid="redmine-issue-status"]`, 'Nueva')
    await expectText(`[data-issue-id="4120"] [data-testid="redmine-issue-hours"]`, '1,5/6 h')
    await expectText(`[data-issue-id="4120"] [data-testid="redmine-issue-project"]`, 'Portal Ejemplo')
    await fillValue(search, 'nominas')
    await expectRowIds([412, 2875])
    await expectText(`[data-issue-id="412"] [data-testid="redmine-issue-hours"]`, '3 h')
    // One match is a one-row list (the detail opens only from the row); a number (with or without #)
    // is that exact id only.
    await fillValue(search, 'DISENO')
    await expectRowIds([4120])
    await expectCount(DETAIL, 0)
    await fillValue(search, '#412')
    await expectRowIds([412])
    await expectCount(DETAIL, 0)
    await fillValue(search, 'nada parecido')
    await expectText('[data-testid="redmine-no-match"]', 'Ninguna tarea coincide')
    // Esc clears the search first (the view stays open, at rest).
    await focus(search)
    await browser.keys('Escape')
    await expectValue(search, '')
    await expectCount(ROWS, 0)
    await expect(panel()).toHaveAttribute('data-body', 'list')

    // The detail of #4012: its status (the allowed ones) and its estimate.
    await openDetail(4012)
    await expectFullViewDetail(4012, 'Revisar los permisos del informe mensual')
    // The hours already logged, under the estimate.
    await expectText(inDetail('redmine-detail-spent'), '0 h imputadas de 2 h')
    const status = inDetail('redmine-detail-status')
    await expectValue(status, '2')
    const options = await inPage(
      (sel: string) =>
        Array.from(
          (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document.querySelectorAll(`${sel} option`),
        ).map((el) => el.textContent ?? ''),
      status,
    )
    expect(options).toEqual(['Nueva', 'En curso', 'Resuelta'])
    await selectValue(status, '3')
    await expectText(inDetail('redmine-detail-task-done'), 'Guardado')
    await expectValue(status, '3')
    expect(server.issue(4012).statusId).toBe(3)
    const estimate = inDetail('redmine-detail-estimate')
    await expectValue(estimate, '2')
    await fillValue(estimate, '3,5')
    await $(inDetail('redmine-detail-estimate-save')).click()
    await expectText(inDetail('redmine-detail-task-done'), 'Guardado')
    await eventually(async () => server.issue(4012).estimatedHours, (hours) => hours === 3.5, 'the estimate saved on the fake')
    await expectValue(estimate, '3,5')
    await expectText(inDetail('redmine-detail-spent'), '0 h imputadas de 3,5 h')

    // Log time: today by default, Redmine's default activity preselected. The default is the
    // renderer's today: Windows' day, except in the known divergence hour (appDays), where the time
    // is logged on the earlier of the two days (main refuses a later one as a future date).
    const logDate = inDetail('redmine-log-date')
    await expectValue(logDate, days.renderer)
    // The field shows the day short, "dd/mm" in Spanish; ↓ goes back one day and ↑ returns (never past today).
    const shortEs = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`
    const dateButton = inDetail('redmine-log-date-button')
    await expectText(dateButton, shortEs(days.renderer))
    await focus(dateButton)
    await browser.keys('ArrowDown')
    await eventually(() => valueOf(logDate), (value) => value !== null && value < days.renderer, 'the date one day back')
    await browser.keys('ArrowUp')
    await expectValue(logDate, days.renderer)
    await browser.keys('ArrowUp')
    await expectValue(logDate, days.renderer)
    let logDay = days.renderer
    if (days.divergent && days.renderer > days.windows) {
      // GAP: in this hour the user sees main refuse the renderer's default log date as a future
      // date (part 4 follow-up #1, the ICU/Windows divergence); the test logs on Windows' day to
      // get past it, so the refusal itself is not asserted.
      console.log(`Known tz-data divergence hour: logging on Windows' day ${days.windows} instead of the renderer's ${days.renderer}`)
      await fillValue(logDate, days.windows)
      logDay = days.windows
    }
    await expectValue(inDetail('redmine-log-activity'), '9')
    await fillValue(inDetail('redmine-log-hours'), '1h 30m') // Redmine's own format: hours and minutes
    await fillValue(inDetail('redmine-log-comment'), REDMINE_LOG_COMMENT)
    await $(inDetail('redmine-log-submit')).click()
    await expectText(inDetail('redmine-log-done'), '1,5 h imputadas')
    await expectValue(inDetail('redmine-log-hours'), '')
    await expectText(inDetail('redmine-detail-spent'), '1,5 h imputadas de 3,5 h')
    expect(await $(inDetail('redmine-detail-spent')).getAttribute('data-over')).toBeNull()
    const logged = server.entries.at(-1)!
    expect(logged).toMatchObject({ issueId: 4012, spentOn: logDay, hours: 1.5, activityId: 9, comments: REDMINE_LOG_COMMENT })

    // "Abrir en Redmine": the configured https server, never the fake's address.
    await $(inDetail('redmine-detail-open')).click()
    await eventually(openedUrls, (urls) => JSON.stringify(urls) === JSON.stringify([`${FAKE_REDMINE_ORIGIN}/issues/4012`]), 'the issue opened')
    expect(await openedUrls()).toEqual([`${FAKE_REDMINE_ORIGIN}/issues/4012`])

    // ← goes back to the search, its text intact and the focus on the issue's row (with its new
    // hours). Searching the project lists #4012 first, with its new status and hours; the summary
    // went up (by the hours of the day logged, counted in Windows' today, week and month).
    await byTestId('redmine-back').click()
    await expect(panel()).toHaveAttribute('data-body', 'list')
    await expectValue(search, '4012')
    await expectRowIds([4012])
    await eventually(() => isFocused(row(4012)), (focused) => focused, 'the focus back on the row of #4012')
    await expectText(`[data-issue-id="4012"] [data-testid="redmine-issue-hours"]`, '1,5/3,5 h')
    await fillValue(search, 'portal')
    await expectRowIds([4012, 4120])
    await expectText(`[data-issue-id="4012"] [data-testid="redmine-issue-status"]`, 'Resuelta')
    await expectText(`[data-issue-id="4012"] [data-testid="redmine-issue-hours"]`, '1,5/3,5 h')
    await focus(search)
    await browser.keys('Escape')
    await expectValue(search, '')
    const added = {
      today: logDay === days.windows ? 1.5 : 0,
      week: logDay >= mondayOf(days.windows) ? 1.5 : 0,
      month: logDay.slice(0, 7) === days.windows.slice(0, 7) ? 1.5 : 0,
    }
    await expectText(summaryCell('today'), hoursEs(seeded.today + added.today))
    await expectText(summaryCell('week'), hoursEs(seeded.week + added.week))
    await expectText(summaryCell('monthTotal'), hoursEs(seeded.month + added.month))

    // A 403 on an issue the user may not touch: the error stays in the form, the session stays connected.
    server.forbiddenIssues.add(2875)
    const entriesBefore = server.entries.length
    await openDetail(2875)
    // More hours logged than estimated: the line turns Rojo Fallo.
    await expectText(inDetail('redmine-detail-spent'), '4,25 h imputadas de 4 h')
    expect(await $(inDetail('redmine-detail-spent')).getAttribute('data-over')).toBe('true')
    await fillValue(inDetail('redmine-log-hours'), '1')
    await $(inDetail('redmine-log-submit')).click()
    await expectText(inDetail('redmine-log-error'), 'Redmine no te deja hacer este cambio')
    await expectCount(inDetail('redmine-log-retry'), 0)
    await expectValue(inDetail('redmine-log-hours'), '1')
    await selectValue(inDetail('redmine-detail-status'), '1')
    await expectText(inDetail('redmine-detail-task-error'), 'Redmine no te deja hacer este cambio')
    await expectValue(inDetail('redmine-detail-status'), '3')
    expect(server.hits['403']).toBe(2)
    expect(server.entries.length).toBe(entriesBefore)
    expect(server.issue(2875).statusId).toBe(3)
    expect((await redmineState()).status).toBe('ok')
    await useWindow('control-center')
    await expectConnected()
    await useWindow('notch')

    // Esc closes the detail (back to its row, the search intact), then clears the search (focus
    // back in the box), then closes the view; the capsule shows today's new total.
    await focus(DETAIL)
    await browser.keys('Escape')
    await expect(panel()).toHaveAttribute('data-body', 'list')
    await expectValue(search, '2875')
    await eventually(() => isFocused(row(2875)), (focused) => focused, 'the focus back on the row of #2875')
    await browser.keys('Escape')
    await expectValue(search, '')
    await eventually(() => isFocused(search), (focused) => focused, 'the focus in the search box')
    await browser.keys('Escape')
    await panel().waitForExist({ reverse: true })
    // WebDriver's clicks left its virtual pointer over the capsule (docs/e2e.md).
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')
    const monthTotal = seeded.month + added.month
    await whileHovered(async () => {
      await expectMetric(monthMetric(monthTotal))
      await expectTextContaining(present('metric-redmine'), `${hoursEs(monthTotal).replace(' ', '')}`)
    })

    await expectNoKeyInDom()
    await useWindow('control-center')
    await expectNoKeyInDom()
    expect(server.violations).toEqual([])
    expect(server.hits['update']).toBe(3)
    expect(server.hits['log']).toBe(2)
    expectCleanLogs()
  })

  it('at rest there is only the summary and the search box', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(panel()).toHaveAttribute('data-body', 'list')
    // The month summary (chart, Hoy · Semana · Mes) and the search box, nothing else under the header.
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')
    await expect(byTestId('redmine-summary')).not.toHaveAttribute('data-compact', 'true')
    const seeded = expectedSeededSummary(new Date())
    await expectText(summaryCell('today'), hoursEs(seeded.today))
    await expect(byTestId('redmine-search')).toBeDisplayed()
    // No assigned-issues list: no rows, no list, no empty-state line, no loading rows.
    await expectCount(ROWS, 0)
    await expectCount('[data-testid="redmine-list"]', 0)
    await expectCount('[data-testid="redmine-no-match"]', 0)
    await expectCount('[data-testid="redmine-loading"]', 0)
    await expectCount(DETAIL, 0)
    expect((await textOf(PANEL))!.toLowerCase()).not.toContain('asignadas')
    // The list is still read (the search runs over it), but nothing shows it until something is typed.
    await eventually(async () => server.hits['issues'] ?? 0, (hits) => hits >= 1, 'the assigned list read for the search')
    // The painted capsule fits the view (plus its 2 px border): no empty room under the search box.
    await eventually(async () => Math.abs((await capsuleBox()).height - ((await panel().getSize('height')) + 2)), (gap) => gap <= 1, 'the capsule fits the view')
    expect((await capsuleBox()).height).toBeLessThan(272)

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('a number in the list is one row; Enter or a click opens its detail over the whole view', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')

    // The exact id of an assigned issue: one row under the box, no detail, the focus stays in the box.
    await fillValue(SEARCH, '4012')
    await expectRowIds([4012])
    await expectCount(DETAIL, 0)
    await expect(panel()).toHaveAttribute('data-body', 'list')
    expect(await isFocused(SEARCH)).toBe(true)
    // Enter in the box opens the lone row: the detail takes the whole view and gets the focus.
    await browser.keys('Enter')
    await eventually(() => $(DETAIL).getAttribute('data-issue-id'), (value) => value === '4012', 'the detail of #4012')
    await expectFullViewDetail(4012, 'Revisar los permisos del informe mensual')
    await $(inDetail('redmine-detail-status')).waitForDisplayed()
    await eventually(() => isFocused(DETAIL), (focused) => focused, 'the focus on the detail')
    await expectText(inDetail('redmine-detail-spent'), '0 h imputadas de 2 h')
    // The capsule fits the detail (plus its 2 px border), never past the search size.
    await eventually(async () => Math.abs((await capsuleBox()).height - ((await panel().getSize('height')) + 2)), (gap) => gap <= 1, 'the capsule fits the detail')
    expect((await capsuleBox()).height).toBeLessThanOrEqual(560)
    // Esc goes back to the search: the text intact, the focus on the row.
    await browser.keys('Escape')
    await expect(panel()).toHaveAttribute('data-body', 'list')
    await expectValue(SEARCH, '4012')
    await expectRowIds([4012])
    await eventually(() => isFocused(row(4012)), (focused) => focused, 'the focus back on the row of #4012')
    // With `#` it is the same kind of row, found in the list, not asked of Redmine; a click opens it.
    await fillValue(SEARCH, '#412')
    await expectRowIds([412])
    await $(row(412)).click()
    await eventually(() => $(DETAIL).getAttribute('data-issue-id'), (value) => value === '412', 'the detail of #412')
    await expectFullViewDetail(412, 'Corregir el cálculo de las vacaciones')
    // Without an estimate, only the hours logged.
    await expectText(inDetail('redmine-detail-spent'), '3 h imputadas')
    await browser.pause(600)
    expect(server.hits['find'] ?? 0).toBe(0)
    // ← in the header goes back the same way.
    await byTestId('redmine-back').click()
    await expectValue(SEARCH, '#412')
    await eventually(() => isFocused(row(412)), (focused) => focused, 'the focus back on the row of #412')
    // Esc then clears the search (the rest is back, the focus in the box), then closes the view.
    await browser.keys('Escape')
    await expectValue(SEARCH, '')
    await expectCount(DETAIL, 0)
    await expectCount(ROWS, 0)
    await expect(panel()).toHaveAttribute('data-body', 'list')
    await eventually(() => isFocused(SEARCH), (focused) => focused, 'the focus in the search box')
    await browser.keys('Escape')
    await panel().waitForExist({ reverse: true })
    await expectMode('expanded')

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('a number outside the list is one row, and opens its detail', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')
    const outside = REDMINE_OUTSIDE_ISSUE

    // Typed digit by digit, quickly: Redmine is asked once, 300 ms after the typing pauses.
    await focus(SEARCH)
    await browser.keys(String(outside.id).split(''))
    await expectValue(SEARCH, String(outside.id))
    expect(server.hits['find'] ?? 0).toBe(0)
    // Found: one row with what Redmine says of it, no detail yet; the focus stays in the box.
    await expectRowIds([outside.id])
    await expectText(`[data-issue-id="${outside.id}"] [data-testid="redmine-issue-subject"]`, outside.subject)
    await expectCount(DETAIL, 0)
    expect(server.hits['find']).toBe(1)
    expect(await isFocused(SEARCH)).toBe(true)

    // With `#` the same number is always asked, whatever the texts say.
    await fillValue(SEARCH, 'nada')
    await expectText('[data-testid="redmine-no-match"]', 'Ninguna tarea coincide')
    await fillValue(SEARCH, `#${outside.id}`)
    await expectRowIds([outside.id])
    expect(server.hits['find']).toBe(2)
    // Enter opens it; the detail works as any other: the issue is read again with its allowed statuses.
    await browser.keys('Enter')
    await eventually(() => $(DETAIL).getAttribute('data-issue-id'), (value) => value === String(outside.id), `the detail of #${outside.id}`)
    await expectFullViewDetail(outside.id, outside.subject)
    await expectValue(inDetail('redmine-detail-status'), String(outside.statusId))
    await expectText(inDetail('redmine-detail-spent'), '0 h imputadas')
    // Esc: back to its row, the search intact.
    await browser.keys('Escape')
    await expectValue(SEARCH, `#${outside.id}`)
    await eventually(() => isFocused(row(outside.id)), (focused) => focused, 'the focus back on the row')

    expect(server.violations).toEqual([])
    expect((await redmineState()).status).toBe('ok')
    expectCleanLogs()
  })

  it('a forbidden number shows no match and keeps the session', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')

    // 403: Redmine hides that issue from the key.
    server.hiddenIssues.add(9403)
    await fillValue(SEARCH, '9403')
    await expectText('[data-testid="redmine-no-match"]', 'Ninguna tarea coincide')
    expect(server.hits['403']).toBe(1)
    await expectCount(DETAIL, 0)
    await expectCount('[data-testid="redmine-status"]', 0)
    // 404: there is no such issue; the same answer.
    await fillValue(SEARCH, '#9404')
    await eventually(async () => server.hits['find'] ?? 0, (hits) => hits === 2, 'the second lookup')
    await expectText('[data-testid="redmine-no-match"]', 'Ninguna tarea coincide')

    // The session is untouched: still connected here, in the Control Center and in the capsule,
    // and the search keeps working.
    expect((await redmineState()).status).toBe('ok')
    await fillValue(SEARCH, '4012')
    await expectRowIds([4012])
    await useWindow('control-center')
    await expectConnected()
    await useWindow('notch')
    await focus(SEARCH)
    await browser.keys('Escape')
    await browser.keys('Escape')
    await panel().waitForExist({ reverse: true })
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')
    await whileHovered(() => expectMetric(monthMetric(seededMonth())).then(() => undefined))

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('several matches show a short list, and the keyboard goes through it', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')

    await fillValue(SEARCH, 'nominas')
    await expectRowIds([412, 2875])
    await expectCount('[data-testid="redmine-list"]', 1)
    await expectCount(DETAIL, 0)
    // Never more than five rows.
    await fillValue(SEARCH, 'a')
    await eventually(async () => (await rowIds()).length, (n) => n >= 2 && n <= 5, 'at most five rows')
    await fillValue(SEARCH, 'nominas')
    await expectRowIds([412, 2875])
    // ↓ from the box goes into the results, ↓ again to the next row.
    expect(await isFocused(SEARCH)).toBe(true)
    await browser.keys('ArrowDown')
    await eventually(() => isFocused(row(412)), (focused) => focused, 'the focus on the first row')
    await browser.keys('ArrowDown')
    await eventually(() => isFocused(row(2875)), (focused) => focused, 'the focus on the second row')
    // Enter opens the row's detail (the focus goes to it).
    await browser.keys('Enter')
    await eventually(() => $(DETAIL).getAttribute('data-issue-id'), (value) => value === '2875', 'the detail of #2875')
    await expectFullViewDetail(2875, 'Documentar la API de clientes')
    // Esc layers: the picked row's detail closes first (back to its row, the list intact) ...
    await browser.keys('Escape')
    await expectRowIds([412, 2875])
    await eventually(() => isFocused(row(2875)), (focused) => focused, 'the focus back on the row of #2875')
    await expectValue(SEARCH, 'nominas')
    // ... then the query (the rest, the focus in the box) ...
    await browser.keys('Escape')
    await expectValue(SEARCH, '')
    await expectCount(ROWS, 0)
    await eventually(() => isFocused(SEARCH), (focused) => focused, 'the focus in the search box')
    expect(await mode()).toBe('redmine')
    // ... then the panel.
    await browser.keys('Escape')
    await panel().waitForExist({ reverse: true })
    await expectMode('expanded')

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('the summary compresses while searching', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')
    const seeded = expectedSeededSummary(new Date())
    // At rest: the full summary, in the rest capsule.
    await expectText(summaryCell('today'), hoursEs(seeded.today))
    await expectCount(SUMMARY_LINE, 0)
    await eventually(async () => Math.abs((await capsuleBox()).height - ((await panel().getSize('height')) + 2)), (gap) => gap <= 1, 'the capsule fits the view')

    // Searching: one line, "Hoy 2,5H · Semana … · Mes …"; the capsule fits the two matches (no empty room under them).
    await fillValue(SEARCH, 'nominas')
    await expectRowIds([412, 2875])
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-compact', 'true')
    await expectText(SUMMARY_LINE, `Hoy ${hoursLine(seeded.today)} · Semana ${hoursLine(seeded.week)} · Mes ${hoursLine(seeded.month)}`)
    await expectCount(summaryCell('today'), 0)
    await eventually(async () => Math.abs((await capsuleBox()).height - ((await panel().getSize('height')) + 2)), (gap) => gap <= 1, 'the capsule fits the matches')
    expect((await capsuleBox()).height).toBeLessThan(560)

    // The line follows the language.
    await setLanguage('en')
    const en = (hours: number) => hoursLine(hours).replace(',', '.')
    await expectText(SUMMARY_LINE, `Today ${en(seeded.today)} · Week ${en(seeded.week)} · Month ${en(seeded.month)}`)
    await setLanguage('es')
    await expectText(SUMMARY_LINE, `Hoy ${hoursLine(seeded.today)} · Semana ${hoursLine(seeded.week)} · Mes ${hoursLine(seeded.month)}`)

    // Clearing the search: the full summary and the rest capsule are back.
    await focus(SEARCH)
    await browser.keys('Escape')
    await expectValue(SEARCH, '')
    await expectText(summaryCell('today'), hoursEs(seeded.today))
    await expectCount(SUMMARY_LINE, 0)
    await eventually(async () => Math.abs((await capsuleBox()).height - ((await panel().getSize('height')) + 2)), (gap) => gap <= 1, 'the capsule fits the view again')

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('a key Redmine later rejects (401) asks to check the key, hides the capsule block and stops querying', async () => {
    const server = fake!
    await connected(server)
    await openRedmineView()
    await expect(panel()).toHaveAttribute('data-body', 'list')
    await expect(byTestId('redmine-summary')).toHaveAttribute('data-phase', 'ready')

    // The key is revoked (or the REST API turned off); the next 5 min query finds out.
    server.unauthorized = true
    await advanceClock(TICK_MS)
    const notice = `${PANEL} [data-testid="redmine-status"]`
    await eventually(() => $(notice).getAttribute('data-notice'), (value) => value === 'auth', 'the auth notice')
    await expectTextContaining(notice, 'Revisa la clave API en Control Center')
    await expectCount(SEARCH, 0)
    await expect(byTestId('redmine-open-control-center')).toBeDisplayed()
    await useWindow('control-center')
    await eventually(() => byTestId('redmine-status').getAttribute('data-status'), (value) => value === 'auth-error', 'the Control Center in auth-error')
    await expectTextContaining(CC_STATUS, 'Revisa la clave: ya no es válida o la API REST está desactivada.')
    await useWindow('notch')

    // No more requests: not on the rhythm, not on a refresh.
    const before = server.requests.count
    await advanceClock(TICK_MS)
    await advanceClock(TICK_MS)
    await inPage(() => (globalThis as unknown as { notch: { redmine: { refresh(): Promise<unknown> } } }).notch.redmine.refresh())
    await browser.pause(1_000)
    expect(server.requests.count).toBe(before)

    // The capsule has no Redmine block left.
    await focus(PANEL)
    await browser.keys('Escape')
    await panel().waitForExist({ reverse: true })
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')
    await whileHovered(() => expectMetric(null).then(() => undefined))

    // A new valid key brings it back.
    server.unauthorized = false
    await useWindow('control-center')
    await saveKey(FAKE_REDMINE_ORIGIN, FAKE_REDMINE_KEY)
    await expectConnected()
    await useWindow('notch')
    await whileHovered(() => expectMetric(monthMetric(seededMonth())).then(() => undefined))

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('the end-of-day alert: on Monday at 18:00 with fewer hours than the target, once; a click opens the view', async () => {
    const server = fake!
    await connected(server)
    // GAP: the Control Center stays open (Electron closes it here); the capsule rests in peek.
    await expectMode('peek')
    // Today's hours are loaded before the clock moves (the check needs a reading for the day).
    expect((await redmineState()).todayHours).toBe(SEEDED_TODAY_HOURS)

    // The test clock jumps to Monday 18:00:30 (inside the alert's 1 h window). The 5 min query falls
    // due on the way and reads that day's hours; the check that runs with the jump has no reading
    // for the new day yet, so it waits for one. Days and times are Windows' (the aligned worker's).
    const realNow = new Date()
    const alertAt = nextMondayAlertTime(realNow)
    const sameDay = localDay(alertAt) === localDay(realNow)
    await advanceClock(alertAt.getTime() - Date.now())
    await eventually(async () => (await redmineState()).updatedAt ?? 0, (at) => at >= alertAt.getTime() - 60_000, "that day's hours read")
    // With that day's hours read, the next check alerts (or the 60 s safety interval already did).
    await advanceClock(0)
    await expectMode('alert')
    const alert = '[data-testid="redmine-alert"]'
    const hours = sameDay ? '2,5' : '0'
    await expect($(alert)).toHaveAttribute('aria-label', `Llevas ${hours} h de 8 h hoy`)
    await expectText(alert, `Llevas ${hours} h de 8 h hoy`)
    await expect($(alert)).toHaveAttribute('aria-live', 'polite')

    // A click opens the Redmine view.
    await $(alert).click()
    await expectMode('redmine')
    await panel().waitForDisplayed()
    await focus(PANEL)
    await browser.keys('Escape')
    await panel().waitForExist({ reverse: true })
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')

    // Once a day: later checks the same evening alert nothing.
    await advanceClock(60_000)
    await advanceClock(TICK_MS)
    await browser.pause(1_000)
    await expectMode('peek')
    expect(await count(alert)).toBe(0)

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })
})
