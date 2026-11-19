/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// GitHub and GitLab code review, ported from 0.1.0's Electron e2e code-review.spec.ts. GitHub's API
// and the GitLab server are the strict fake of tests/e2e-tauri/fixtures/fake-code-review.ts, started in
// this process on 127.0.0.1 and passed per launch as `--e2e-env-NOTCH_CODE_REVIEW_BASE_URLS` (the
// settings still hold the https GitLab URL). Every test asserts the fake saw the requests and no
// protocol violation. URLs main would open are recorded (`NOTCH_OPEN_URL_LOG=1`, read with
// `__e2e:opened-urls`), never opened: the recorder is checked to be on before anything is clicked.
// The 120 s and 15 min rhythms move with `__e2e:advance-clock`; the queries it fires run after it
// answers, so their effects are polled with `eventually`.
//
// Hover is `pointer()` (`__e2e:pointer`), as in the other Tauri specs.
// GAP: the Electron spec closes the Control Center (`cc.close()`); here it stays open (no close
// channel, as in claude.spec.ts) and WebDriver switches between the two webviews.
// The 6 s review alert ends at whichever comes first: 6 s of real time, or the test clock moving
// past that point (the notch timers run over real time in the e2e build). The spec does not move
// the clock while an alert is up, so it checks the real-time end like Electron (4–12 s).
// KNOWN DIVERGENCE (follow-up, not fixed in part 4): Rust (`chrono::Local`) takes local days from
// Windows' time zone rules, while the WebView2 renderer (JS `Date`) and Electron use ICU's tz data.
// Where the two disagree, the app's main and renderer disagree on the local day for an hour a day.
// Harness measure: the worker runs on Windows' fixed offset (helpers.ts `alignZoneWithWindows`), so
// the fake checks the contributions ranges against the app's days, and the expected data is built
// from Windows' day. Only in the known divergence hour (the worker had to be aligned, the renderer's
// day is ICU's day in the worker's original zone, and it is exactly one day from Windows') are the
// checks that depend on the renderer's today skipped, with a log line (`appDays`); any other
// difference between the two days fails.
// GAP: `expandPanel` retries a panel opening lost to a focus-loss dismiss (a known follow-up; see
// its comment and docs/e2e.md); every other failure to open fails at once.
// GAP: screenshots (test-results/code-review-*.png, contributions-*.png) are not assertions and are
// left out, as in the other Tauri specs; so are the `hover()` calls that only placed the pointer for them.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  FAKE_GITHUB_LOGIN,
  FAKE_GITHUB_TOKEN,
  FAKE_GITLAB_ORIGIN,
  FAKE_GITLAB_TOKEN,
  FAKE_GITLAB_USER,
  GITHUB_MINE,
  GITLAB_MINE,
  GITHUB_TODAY_COUNT,
  GITLAB_BIG_PUSH_COMMITS,
  SENSITIVE_DATA,
  expectedGithubContributions,
  expectedGitlabContributions,
  expectedLevel,
  localDay,
  parseLocalDay,
  githubPrUrl,
  gitlabMrUrl,
  startFakeCodeReview,
  type ExpectedContributions,
  type FakeCodeReview,
} from './fixtures/fake-code-review'
import {
  clickCard,
  DEFAULT_ALERTS,
  advanceClock,
  alignZoneWithWindows,
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
  present,
  quitApp,
  readLogs,
  requestIntent,
  seededSettings,
  setLanguage,
  useWindow,
  whileHovered,
} from './helpers'

/** The 120 s query rhythm of both platforms. */
const TICK_MS = 120_000
/** The contributions rhythm while the "Revisiones" view is open. */
const CONTRIBUTIONS_TICK_MS = 15 * 60_000
/** The minimum gap between two contributions queries started by opening the main panel. */
const PANEL_REFRESH_MS = 60_000
/** The minimum gap between two manual refreshes (Actualizar, Reintentar). */
const REFRESH_REST_MS = 5_000

let fake: FakeCodeReview | undefined

const capsule = () => $('[data-testid="notch-capsule"]')
const byTestId = (id: string) => $(`[data-testid="${id}"]`)
const mode = () => capsule().getAttribute('data-mode')
const expectMode = (value: string, timeout?: number) => eventually(mode, (current) => current === value, `data-mode=${value}`, timeout)

/** Settings: nothing connected yet (GitLab without a server), alerts on but silent. */
const settings = () => ({
  ...seededSettings(DEFAULT_ALERTS),
  codeReview: { gitlabUrl: '', alerts: { github: { enabled: true, sound: false }, gitlab: { enabled: true, sound: false } } },
})

/** A fresh app on the fake: its GitHub API and GitLab server, URLs recorded instead of opened. */
async function start(server: FakeCodeReview): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(server.base)) throw new Error(`Unexpected fake origin ${server.base}`)
  await launch({
    fresh: true,
    env: { NOTCH_CODE_REVIEW_BASE_URLS: `github=${server.base},gitlab=${server.base}`, NOTCH_OPEN_URL_LOG: '1' },
    files: { 'settings.json': settings() },
  })
  // The recorder must be on before anything is clicked (UNAVAILABLE otherwise): never a real browser.
  expect(await openedUrls()).toEqual([])
}

/** Opens the Control Center on its code review page; WebDriver stays on it. */
async function openCodeReviewPage(): Promise<void> {
  await openControlCenter('code-review')
  await byTestId('code-review-page').waitForDisplayed()
}

const card = (platform: 'github' | 'gitlab') => `[data-testid="code-review-${platform}"]`
const statusText = (platform: 'github' | 'gitlab') => byTestId(`code-review-${platform}-status`).$('span')
const tokenLabel = (platform: 'github' | 'gitlab') => (platform === 'github' ? 'Token de GitHub' : 'Token de GitLab')
const submit = (platform: 'github' | 'gitlab') => $(card(platform)).$('.//button[normalize-space()="Comprobar y guardar"]')

/** "Comprobar y guardar" on one card of the Control Center (WebDriver on it). */
async function saveToken(platform: 'github' | 'gitlab', token: string, url?: string): Promise<void> {
  if (url !== undefined) await fillValue(await labelledField(card(platform), 'URL de GitLab'), url)
  const field = await labelledField(card(platform), tokenLabel(platform))
  await fillValue(field, token)
  await expect($(field)).toHaveAttribute('type', 'password')
  await submit(platform).click()
}

const expectConnected = async (platform: 'github' | 'gitlab'): Promise<void> => {
  await expect(statusText(platform)).toHaveText(`Conectado como ${platform === 'github' ? FAKE_GITHUB_LOGIN : FAKE_GITLAB_USER.username}`)
}

/** The capsule's review block of `platform` (the present copy): its aria-label, or null when absent. */
const reviewMetric = async (platform: 'github' | 'gitlab'): Promise<string | null> => {
  const blocks = await $$(present(`metric-review-${platform}`))
  return blocks.length === 0 ? null : blocks[0]!.getAttribute('aria-label')
}
const expectMetric = (platform: 'github' | 'gitlab', label: string | null) =>
  eventually(() => reviewMetric(platform), (value) => value === label, `the ${platform} block ${label ?? 'absent'}`)

/** Launch, connect both platforms from the Control Center; the capsule shows GitHub 2 and GitLab 1. WebDriver ends on the notch. */
async function connected(server: FakeCodeReview): Promise<void> {
  await start(server)
  await openCodeReviewPage()
  await saveToken('github', FAKE_GITHUB_TOKEN)
  await expectConnected('github')
  await saveToken('gitlab', FAKE_GITLAB_TOKEN, FAKE_GITLAB_ORIGIN)
  await expectConnected('gitlab')
  await useWindow('notch')
  await whileHovered(async () => {
    await expectMetric('github', '2 PR tuyos sin revisar en GitHub')
    await expectMetric('gitlab', '1 MR tuyo sin revisar en GitLab')
  })
}

const panel = () => byTestId('reviews-panel')

/** Panel openings lost to a focus-loss dismiss and retried in this worker (reported at the end). */
let focusLossRetries = 0

/** Dismisses out of an open panel the controller has logged so far (`notch: mode change from expanded to … on Dismiss`). */
const panelDismissesLogged = (): number => (readLogs().match(/notch: mode change from expanded to \w+ on Dismiss/g) ?? []).length

/**
 * Opens the panel and checks it stays open. GAP / KNOWN FOLLOW-UP: with the Control Center left
 * open, the Tauri panel can lose the OS focus about 30 ms after expanding (seen in 2 of 4 runs under
 * WebDriver). In the e2e runs every focus loss with the panel open went to another app's window
 * (taskbar, terminal, popups), so closing the panel is correct; each one is the
 * `notch: focus lost (...)` debug line in `%APPDATA%\dev.developernotch.app\logs\main.log`.
 * Pending verification with real input. The panel closes on
 * `Focused(false)` → Dismiss. Only that case is retried (at most 3 times, each logged and counted):
 * the spec sends no dismiss here, so a new "from expanded … on Dismiss" line in the controller's log
 * is the window's focus loss. Anything else (never expanding, closing without that line) fails at once.
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

async function openReviewsView(platform: 'github' | 'gitlab' = 'github'): Promise<void> {
  await expandPanel()
  await clickCard(`integration-${platform}`)
  await expectMode('reviews')
  await panel().waitForDisplayed()
  await expect(panel()).toHaveAttribute('data-platform', platform)
}

/** Focuses the first element matching `selector` (Playwright's `locator.focus()`). */
const focus = (selector: string, index = 0): Promise<void> =>
  inPage(
    (sel: string, at: number) => {
      const el = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ focus(): void }> } }).document.querySelectorAll(sel)[at]
      if (!el) throw new Error(`No element ${sel} #${at}`)
      el.focus()
    },
    selector,
    index,
  )

/** Esc from the focused panel back to the tile row. */
async function closeReviewsView(): Promise<void> {
  await focus('[data-testid="reviews-panel"]')
  await browser.keys('Escape')
  await panel().waitForExist({ reverse: true })
}

/** The view has no tabs: Esc back to the tile row, then the other platform's tile. */
async function switchReviewsPlatform(platform: 'github' | 'gitlab'): Promise<void> {
  await closeReviewsView()
  await clickCard(`integration-${platform}`)
  await eventually(() => panel().getAttribute('data-platform'), (value) => value === platform, `the ${platform} view`)
}

/** The reviews view is one platform per opening: no tablist, no tab, and the header names the platform. */
async function expectNoTabs(name: 'GitHub' | 'GitLab'): Promise<void> {
  expect(await $$('[role="tablist"]')).toHaveLength(0)
  expect(await $$('[role="tab"]')).toHaveLength(0)
  await expect(panel().$('h2')).toHaveText(name)
  await expect(panel()).toHaveAttribute('aria-label', name)
}

/** What the GitLab row writes for the account: the server without `https://` in front. */
const GITLAB_ACCOUNT = `${FAKE_GITLAB_ORIGIN.replace('https://', '')} · ${FAKE_GITLAB_USER.username}`

/** The account row under the contributions: the account (the server in front on GitLab) and the platform's button. */
async function expectProfile(name: 'GitHub' | 'GitLab', account: string, button: string): Promise<void> {
  const row = byTestId('reviews-profile')
  await row.waitForDisplayed()
  await expect(row.$('[data-testid="reviews-account"]')).toHaveText(account)
  await expect(byTestId('reviews-open-profile')).toHaveText(button)
  await expect(panel()).toHaveAttribute('data-platform', name.toLowerCase())
}

/** The token never stays in the current window: not in the markup, not in any field's value. */
async function expectNoTokenInDom(): Promise<void> {
  const { html, values } = await pageTextAndValues()
  for (const token of [FAKE_GITHUB_TOKEN, FAKE_GITLAB_TOKEN]) {
    expect(html.includes(token)).toBe(false)
    expect(values.join('\n').includes(token)).toBe(false)
  }
}

/**
 * No token, title, repository, author or account in the log, nor any token in plain text in the
 * data folder; each saved token is there, encrypted.
 */
function expectCleanLogs(): void {
  const logs = readLogs()
  expect(logs).toContain('code-review') // the integration did log (states and counts)
  for (const piece of SENSITIVE_DATA) expect({ piece, inLog: logs.includes(piece) }).toEqual({ piece, inLog: false })
  for (const name of readdirSync(dataDir())) {
    const file = join(dataDir(), name)
    if (!statSync(file).isFile()) continue
    const content = readFileSync(file).toString('latin1')
    for (const token of [FAKE_GITHUB_TOKEN, FAKE_GITLAB_TOKEN]) expect({ name, plainToken: content.includes(token) }).toEqual({ name, plainToken: false })
  }
}

const readSettingsFile = (): { codeReview: { gitlabUrl: string } } =>
  JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8')) as { codeReview: { gitlabUrl: string } }

const notchWindowVisible = async (): Promise<boolean> => (await capsuleWindow()).visible

// --- Contributions --------------------------------------------------------------------------

const contributionsBlock = () => byTestId('contributions')
const graph = () => byTestId('contribution-graph')
const contributionHits = (server: FakeCodeReview) => ({
  github: server.hits['github contributions'] ?? 0,
  gitlab: server.hits['gitlab contributions'] ?? 0,
})
const expectContributionHits = (server: FakeCodeReview, expected: { github: number; gitlab: number }) =>
  eventually(
    async () => contributionHits(server),
    (hits) => hits.github === expected.github && hits.gitlab === expected.gitlab,
    `contributions queries ${JSON.stringify(expected)}`,
  )

const intlLocale = (language: 'es' | 'en') => (language === 'es' ? 'es-ES' : 'en-US')
/** "13 nov" / "Nov 13", as the chart writes a day. */
const shortDateText = (key: string, language: 'es' | 'en') =>
  new Intl.DateTimeFormat(intlLocale(language), { day: 'numeric', month: 'short' }).format(new Date(`${key}T12:00:00`)).replace('.', '')
const monthNameText = (key: string, language: 'es' | 'en') =>
  new Intl.DateTimeFormat(intlLocale(language), { month: 'long' }).format(new Date(`${key.slice(0, 7)}-01T12:00:00`))
const countText = (count: number, language: 'es' | 'en') =>
  language === 'es' ? (count === 1 ? '1 contribución' : `${count} contribuciones`) : count === 1 ? '1 contribution' : `${count} contributions`

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
 * the renderer's (its JS `Date`, ICU). They may differ ONLY in the known divergence hour: the worker
 * had to be aligned, the renderer's day is ICU's day in the worker's original zone, and the two are
 * exactly one day apart. Any other difference fails here. In that hour the checks that depend on
 * the renderer's today (the ring, the Tab stop and day line, today's aria-label) are skipped and
 * logged; everything built from the app's data is still checked against Windows' day.
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
  console.log(
    `Known tz-data divergence hour: the renderer's today (${renderer}) is not Windows' local date (${windows}); skipping the checks that depend on the renderer's today`,
  )
  return { windows, renderer, divergent }
}

/** Today for the expected data: Windows' local date (the day the app queried and summarized). */
const appToday = async (): Promise<Date> => parseLocalDay((await appDays()).windows)

/** The chart's day squares: date, level and whether outlined as future. */
const chartCells = (): Promise<{ date: string; level: number; future: boolean }[]> =>
  inPage(() => {
    type El = { getAttribute(name: string): string | null; hasAttribute(name: string): boolean; querySelectorAll(s: string): ArrayLike<El> }
    const root = (globalThis as unknown as { document: { querySelector(s: string): El | null } }).document.querySelector('[data-testid="contribution-graph"]')
    return Array.from(root?.querySelectorAll('[data-date]') ?? []).map((el) => ({
      date: el.getAttribute('data-date') ?? '',
      level: Number(el.getAttribute('data-level')),
      future: el.hasAttribute('data-future'),
    }))
  })

/**
 * The open view's chart and summary against the fake's month: one square per day of the month, the
 * level of every day up to today (later days outlined as future), the 12 summary numbers and the
 * month's total line.
 */
async function expectContributions(expected: ExpectedContributions, language: 'es' | 'en'): Promise<void> {
  await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
  const days = await appDays()
  const today = parseLocalDay(days.windows)
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const shown = await eventually(chartCells, (cells) => cells.length === daysInMonth, `${daysInMonth} day squares`)
  const max = Math.max(...expected.counts.values())
  for (const cell of shown) {
    const count = expected.counts.get(cell.date)
    if (count === undefined) {
      expect({ date: cell.date, future: cell.future }).toEqual({ date: cell.date, future: true })
      continue
    }
    expect({ date: cell.date, future: cell.future, level: cell.level }).toEqual({ date: cell.date, future: false, level: expectedLevel(count, max) })
  }
  // Today is the busiest day of the fake's month: the darkest square, ringed by the renderer.
  if (!days.divergent) {
    await expect(graph().$('[data-today]')).toHaveAttribute('data-date', days.windows)
    await expect(graph().$('[data-today]')).toHaveAttribute('data-level', '4')
  }

  const summary = byTestId('contribution-summary')
  for (const row of ['commits', 'opened', 'merged', 'reviews'] as const) {
    for (const [column, totals] of [
      ['today', expected.today],
      ['week', expected.week],
      ['monthTotals', expected.month],
    ] as const) {
      await expect(summary.$(`[data-row="${row}"] [data-column="${column}"]`)).toHaveText(String(totals[row]))
    }
  }
  const month = monthNameText(localDay(today), language)
  await expect(byTestId('contributions-total')).toHaveText(
    language === 'es' ? `${countText(expected.monthTotal, 'es')} en el gráfico de ${month}` : `${countText(expected.monthTotal, 'en')} in ${month}'s chart`,
  )
}

/** The id of the element that has the focus in the page. */
const focusedDate = (): Promise<string | null> =>
  inPage(
    () =>
      (globalThis as unknown as { document: { activeElement: { getAttribute(name: string): string | null } | null } }).document.activeElement?.getAttribute(
        'data-date',
      ) ?? null,
  )
const expectFocusedDay = (key: string) => eventually(focusedDate, (value) => value === key, `focus on ${key}`)

describe('Code review (Tauri)', () => {
  before(() => {
    // The fake's local midnights must be the app's (Rust follows Windows' zone rules; see the
    // KNOWN DIVERGENCE note above and alignZoneWithWindows). The original zone is kept to tell the
    // divergence hour from a real failure (appDays).
    originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const zone = alignZoneWithWindows()
    alignedZone = zone
    if (zone) console.log(`Node's tz data disagrees with Windows' here: this worker runs on ${zone}, the offset Windows uses (known divergence)`)
  })

  beforeEach(async () => {
    fake = await startFakeCodeReview()
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

  it('save tokens in Control Center, counts in the capsule, the GitHub and GitLab tiles open the contributions view', async () => {
    const server = fake!
    await start(server)
    await openCodeReviewPage()
    await expect(byTestId('code-review-github-status')).toHaveAttribute('data-status', 'unconfigured')
    await expect(byTestId('code-review-gitlab-status')).toHaveAttribute('data-status', 'unconfigured')
    // Nothing configured: nothing is asked of either platform, no block in the capsule.
    expect(server.requests).toEqual({ github: 0, gitlab: 0 })
    await useWindow('notch')
    await whileHovered(async () => {
      expect(await reviewMetric('github')).toBeNull()
    })

    // GitHub: the token is checked against the API, the account shows, the field is emptied.
    await useWindow('control-center')
    await saveToken('github', FAKE_GITHUB_TOKEN)
    await expectConnected('github')
    await expect($(await labelledField(card('github'), 'Token de GitHub'))).toHaveValue('')
    expect(server.hits['github viewer']).toBe(1)

    // Only GitHub is connected: the GitLab tile opens the view on GitLab with its "sin configurar" state.
    await useWindow('notch')
    await openReviewsView('gitlab')
    await expectNoTabs('GitLab')
    await expect(byTestId('reviews-status')).toHaveAttribute('data-notice', 'unconfigured')
    await expect(byTestId('reviews-status')).toHaveText(expect.stringContaining('Conecta GitHub o GitLab en Control Center'))
    await closeReviewsView()
    // WebDriver's click on the tile left its virtual pointer over the capsule (docs/e2e.md).
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')

    // GitLab: a plain-http server is refused before anything is sent.
    await useWindow('control-center')
    await saveToken('gitlab', FAKE_GITLAB_TOKEN, 'http://gitlab.example.test')
    await expect(byTestId('code-review-gitlab-error')).toHaveText('La URL debe empezar por https://')
    await expect(byTestId('code-review-gitlab-status')).toHaveAttribute('data-status', 'unconfigured')
    expect(server.requests.gitlab).toBe(0)
    // The https server is accepted and saved (normalized) in settings; the token never is.
    await fillValue(await labelledField(card('gitlab'), 'URL de GitLab'), FAKE_GITLAB_ORIGIN)
    await submit('gitlab').click()
    await expectConnected('gitlab')
    await expect($(await labelledField(card('gitlab'), 'Token de GitLab'))).toHaveValue('')
    await byTestId('code-review-gitlab-error').waitForExist({ reverse: true })
    await eventually(async () => readSettingsFile().codeReview.gitlabUrl, (url) => url === FAKE_GITLAB_ORIGIN, 'the GitLab URL in settings.json')
    await expectNoTokenInDom()

    // The capsule: one block per platform with its own unreviewed PR/MRs (drafts and reviewed ones left out).
    await useWindow('notch')
    await whileHovered(async () => {
      await expectMetric('github', '2 PR tuyos sin revisar en GitHub')
      await expectMetric('gitlab', '1 MR tuyo sin revisar en GitLab')
      await expect($(present('metric-review-github'))).toHaveText(expect.stringContaining('2'))
      await expect($(present('metric-review-gitlab'))).toHaveText(expect.stringContaining('1'))
    })

    // The view from the GitHub tile: no tabs, the header says GitHub, the contributions and the account row.
    await openReviewsView('github')
    await expectNoTabs('GitHub')
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
    await expectProfile('GitHub', FAKE_GITHUB_LOGIN, 'Abrir GitHub')

    await setLanguage('en')
    await expectProfile('GitHub', FAKE_GITHUB_LOGIN, 'Open GitHub')
    await setLanguage('es')
    await expectProfile('GitHub', FAKE_GITHUB_LOGIN, 'Abrir GitHub')

    // The GitLab tile: the header says GitLab, the server in front of the account.
    await switchReviewsPlatform('gitlab')
    await expectNoTabs('GitLab')
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
    await expectProfile('GitLab', GITLAB_ACCOUNT, 'Abrir GitLab')

    // Nothing was opened by looking at the views: only the buttons and the alerts open pages.
    expect(await openedUrls()).toEqual([])

    // No token in any window; the protocol was spoken right (headers, queries, no per-MR call for the draft).
    await expectNoTokenInDom()
    await useWindow('control-center')
    await expectNoTokenInDom()
    expect(server.violations).toEqual([])
    expect(server.hits['github fetch']).toBeGreaterThanOrEqual(1)
    expect(server.hits['gitlab mine']).toBeGreaterThanOrEqual(1)
    expect(server.hits['gitlab approvals']).toBeGreaterThanOrEqual(2)
    expectCleanLogs()
  })

  it('a first review shows the alert (also over a capsule hidden with "Ocultar") and lowers the count', async () => {
    const server = fake!
    await connected(server)
    await expectMode('peek')

    // Someone approves one of the user's PRs; the next 120 s query (test clock) sees its first review.
    const [first] = GITHUB_MINE
    server.reviewPr(first!.id, 'approved')
    await advanceClock(TICK_MS)
    await expectMode('alert')
    const alert = byTestId('review-alert')
    const shownAt = Date.now()
    await expect(alert).toHaveText(`Aprobado · web-app#${first!.number} · ${first!.title}`)
    await expect(alert).toHaveAttribute('aria-live', 'polite')
    // It ends on its own after about 6 s of real time (the clock is not moved meanwhile); the GitHub count went down by one.
    await expectMode('peek', 12_000)
    expect(Date.now() - shownAt).toBeGreaterThan(4_000)
    await whileHovered(async () => {
      await expectMetric('github', '1 PR tuyo sin revisar en GitHub')
      await expectMetric('gitlab', '1 MR tuyo sin revisar en GitLab')
    })

    // The user hides the notch ("Ocultar"): the window leaves the screen, the queries go on.
    await expandPanel()
    await $('button[aria-label="Ocultar"]').click()
    await capsule().waitForExist({ reverse: true })
    await eventually(notchWindowVisible, (visible) => !visible, 'the notch window hidden')

    // Changes are requested on the user's GitLab MR: the alert shows over the hidden capsule, then hides again.
    const [mr] = GITLAB_MINE
    server.reviewMr(mr!.iid, 'changes')
    await advanceClock(TICK_MS)
    await expectMode('alert')
    await expect(alert).toHaveText(`Cambios pedidos · frontend!${mr!.iid} · ${mr!.title}`)
    expect(await notchWindowVisible()).toBe(true)
    await capsule().waitForExist({ reverse: true, timeout: 12_000 })
    await eventually(notchWindowVisible, (visible) => !visible, 'the notch window hidden again')

    // Shown again: GitHub still has one unreviewed PR.
    await expandPanel()
    await pointer(false)
    await requestIntent('dismiss')
    await pointer(false)
    await expectMode('peek')
    await whileHovered(() => expectMetric('github', '1 PR tuyo sin revisar en GitHub').then(() => undefined))

    // A later query with nothing new alerts nothing; GitLab has nothing unreviewed left, so its block
    // is gone at once (a live 0 does not linger).
    const gitlabBefore = server.requests.gitlab
    await advanceClock(TICK_MS)
    await eventually(async () => server.requests.gitlab, (n) => n > gitlabBefore, 'the next GitLab query')
    await browser.pause(500)
    await expectMode('peek')
    await whileHovered(() => expectMetric('gitlab', null).then(() => undefined))
    expect(await $$('[data-testid="review-alert"]')).toHaveLength(0)

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('a rejected token (401) shows "Revisa el token" in the view and the Control Center and stops querying that platform', async () => {
    const server = fake!
    await connected(server)
    await openReviewsView()
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')

    // GitHub now refuses the token (expired or revoked); the next query finds out.
    server.unauthorized.github = true
    await advanceClock(TICK_MS)
    const status = byTestId('reviews-status')
    await expect(status).toHaveAttribute('data-notice', 'auth')
    await expect(status).toHaveText(expect.stringContaining('Revisa el token en Control Center'))
    await contributionsBlock().waitForExist({ reverse: true })
    expect(await $$('[data-testid="reviews-profile"]')).toHaveLength(0)
    await expect(byTestId('reviews-open-control-center')).toBeDisplayed()
    await useWindow('control-center')
    await expect(byTestId('code-review-github-status')).toHaveAttribute('data-status', 'auth-error')
    await expect(byTestId('code-review-github-status')).toHaveText(expect.stringContaining('Revisa el token'))
    // GitLab is unaffected: its tile still shows its contributions.
    await useWindow('notch')
    await switchReviewsPlatform('gitlab')
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')

    // No more GitHub requests: not on the rhythm, not on a refresh. GitLab keeps going.
    const githubBefore = server.requests.github
    const gitlabBefore = server.requests.gitlab
    await advanceClock(TICK_MS)
    await advanceClock(TICK_MS)
    await inPage(() => (globalThis as unknown as { notch: { codeReview: { refresh(): Promise<unknown> } } }).notch.codeReview.refresh())
    await eventually(async () => server.requests.gitlab, (n) => n > gitlabBefore, 'more GitLab requests')
    await browser.pause(1_000)
    expect(server.requests.github).toBe(githubBefore)

    // GitLab too: both cards ask for a new token; the capsule has no review block left.
    server.unauthorized.gitlab = true
    await advanceClock(TICK_MS)
    await useWindow('control-center')
    await expect(byTestId('code-review-gitlab-status')).toHaveAttribute('data-status', 'auth-error')
    await useWindow('notch')
    await expect(status).toHaveAttribute('data-notice', 'auth')
    const gitlabAfter = server.requests.gitlab
    await advanceClock(TICK_MS)
    await browser.pause(1_000)
    expect(server.requests.gitlab).toBe(gitlabAfter)
    await closeReviewsView()
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')
    await whileHovered(async () => {
      await expectMetric('github', null)
      await expectMetric('gitlab', null)
    })

    // A new valid token brings GitHub back.
    server.unauthorized.github = false
    await useWindow('control-center')
    await saveToken('github', FAKE_GITHUB_TOKEN)
    await expectConnected('github')
    await useWindow('notch')
    await whileHovered(() => expectMetric('github', '2 PR tuyos sin revisar en GitHub').then(() => undefined))

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('the view shows contributions and no review lists', async () => {
    const server = fake!
    await connected(server)
    for (const platform of ['github', 'gitlab'] as const) {
      if (platform === 'github') await openReviewsView('github')
      else await switchReviewsPlatform('gitlab')
      await expectNoTabs(platform === 'github' ? 'GitHub' : 'GitLab')
      await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
      // The chart and the summary, then the account row: that is all the view holds.
      await expect(byTestId('contribution-graph')).toBeDisplayed()
      await expect(byTestId('contribution-summary')).toBeDisplayed()
      await expect(byTestId('reviews-profile')).toBeDisplayed()
      expect(await $$('[data-testid="review-item"]')).toHaveLength(0)
      expect(await $$('[data-section]')).toHaveLength(0)
      expect(await $$('[id^="reviews-section-"]')).toHaveLength(0)
      expect(await $$('[data-testid="reviews-loading"]')).toHaveLength(0)
      const text = await panel().getText()
      for (const gone of ['Por revisar', 'Míos', 'POR REVISAR', 'MÍOS']) expect({ gone, shown: text.includes(gone) }).toEqual({ gone, shown: false })
    }
    // Neither platform was asked for "pending my review": the fake refuses those queries.
    expect(server.violations).toEqual([])
    expect(await openedUrls()).toEqual([])
    expectCleanLogs()
  })

  it('open profile opens the platform in the browser', async () => {
    const server = fake!
    await connected(server)
    await openReviewsView('github')
    await expectProfile('GitHub', FAKE_GITHUB_LOGIN, 'Abrir GitHub')
    await byTestId('reviews-open-profile').click()
    // Main builds the page from the account it knows: github.com, never anything the renderer sent.
    await eventually(openedUrls, (urls) => urls.length === 1, 'the GitHub profile opened')
    expect(await openedUrls()).toEqual([`https://github.com/${FAKE_GITHUB_LOGIN}`])

    await switchReviewsPlatform('gitlab')
    await expectProfile('GitLab', GITLAB_ACCOUNT, 'Abrir GitLab')
    await byTestId('reviews-open-profile').click()
    await eventually(openedUrls, (urls) => urls.length === 2, 'the GitLab profile opened')
    // The configured https server (never the fake's loopback address).
    expect(await openedUrls()).toEqual([`https://github.com/${FAKE_GITHUB_LOGIN}`, `${FAKE_GITLAB_ORIGIN}/${FAKE_GITLAB_USER.username}`])
    // The view stays where it was after opening the page.
    await expect(panel()).toHaveAttribute('data-platform', 'gitlab')

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('a single review alert opens the pull request', async () => {
    const server = fake!
    await connected(server)
    await expectMode('peek')

    // One own PR is reviewed: the alert names it, and a click opens that PR and puts the alert away.
    const [firstPr] = GITHUB_MINE
    server.reviewPr(firstPr!.id, 'approved')
    await advanceClock(TICK_MS)
    await expectMode('alert')
    await expect(byTestId('review-alert')).toHaveText(`Aprobado · web-app#${firstPr!.number} · ${firstPr!.title}`)
    const clickedAt = Date.now()
    await byTestId('review-alert').click()
    await eventually(openedUrls, (urls) => urls.length === 1, 'the PR opened')
    expect(await openedUrls()).toEqual([githubPrUrl(firstPr!)])
    await pointer(false)
    // Main retracts the alert when it opens the page: it is gone well before its 6 s expiry.
    await expectMode('peek', 4_000)
    expect(Date.now() - clickedAt).toBeLessThan(5_000)
    expect(await $$('[data-testid="review-alert"]')).toHaveLength(0)
    // Exactly one tab for that PR.
    expect(await openedUrls()).toEqual([githubPrUrl(firstPr!)])

    // The same on GitLab: the MR opens on the configured server.
    const [firstMr] = GITLAB_MINE
    server.reviewMr(firstMr!.iid, 'changes')
    await advanceClock(TICK_MS)
    await expectMode('alert')
    await expect(byTestId('review-alert')).toHaveText(`Cambios pedidos · frontend!${firstMr!.iid} · ${firstMr!.title}`)
    await byTestId('review-alert').click()
    await eventually(openedUrls, (urls) => urls.length === 2, 'the MR opened')
    expect(await openedUrls()).toEqual([githubPrUrl(firstPr!), gitlabMrUrl(firstMr!)])
    await pointer(false)
    await expectMode('peek')

    // Only pull request pages ever opened, and no view.
    for (const url of await openedUrls()) expect({ url, allowed: url.startsWith('https://github.com/') || url.startsWith(`${FAKE_GITLAB_ORIGIN}/`) }).toEqual({ url, allowed: true })
    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('several review alerts open the contributions view', async () => {
    const server = fake!
    await connected(server)
    await expectMode('peek')

    // Both unreviewed PRs are reviewed before the next query: one alert for the two.
    for (const pr of GITHUB_MINE.slice(0, 2)) server.reviewPr(pr.id, 'approved')
    await advanceClock(TICK_MS)
    await expectMode('alert')
    await expect(byTestId('review-alert')).toHaveText('2 PR revisados · GitHub')
    await byTestId('review-alert').click()
    // Not a page: the contributions view of that platform opens, and nothing went to the browser.
    await expectMode('reviews')
    await panel().waitForDisplayed()
    await expect(panel()).toHaveAttribute('data-platform', 'github')
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
    expect(await openedUrls()).toEqual([])

    await closeReviewsView()
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')
    expect(await openedUrls()).toEqual([])

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })

  it('contributions: the month chart and summary per platform, keyboard, and queries only while the view is open', async () => {
    const server = fake!
    await connected(server)
    // Both platforms connected, the view closed: no contributions asked yet.
    expect(contributionHits(server)).toEqual({ github: 0, gitlab: 0 })

    // Opening the panel asks each platform once for its card (GitLab: two pages of events). Waiting
    // for both cards keeps the view's query apart: one started during the panel's would share it.
    await expandPanel()
    await expectContributionHits(server, { github: 1, gitlab: 1 })
    await eventually(async () => server.hits['gitlab events'], (n) => n === 2, 'two pages of GitLab events')
    await $('[data-testid="integration-github"] .digits').waitForExist()
    await $('[data-testid="integration-gitlab"] .digits').waitForExist()
    // Opening "Revisiones" asks again, whatever the panel just did.
    await clickCard('integration-github')
    await expectMode('reviews')
    await panel().waitForDisplayed()
    await expectContributionHits(server, { github: 2, gitlab: 2 })
    await eventually(async () => server.hits['gitlab events'], (n) => n === 4, 'four pages of GitLab events')

    // GitHub: the month's calendar (today 12, the rest 0/3/6/9/2), the totals and the merged searches.
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
    // Expected data from Windows' day (the app's); only in the known divergence hour are the checks
    // that depend on the renderer's today skipped (see appDays).
    const { divergent } = await appDays()
    const today = await appToday()
    const github = expectedGithubContributions(today)
    await expectContributions(github, 'es')
    if (!divergent) await expect(graph().$('[role="grid"]')).toHaveAttribute('aria-label', `Contribuciones de ${monthNameText(localDay(today), 'es')}`)
    await expect(byTestId('contributions-restricted')).toHaveText('Incluye contribuciones privadas que no se detallan')
    expect(await $$('[data-testid="contributions-partial"]')).toHaveLength(0)
    expect(await $$('[data-testid="contributions-error"]')).toHaveLength(0)
    // Under the chart only the account row: no review list.
    await expectProfile('GitHub', FAKE_GITHUB_LOGIN, 'Abrir GitHub')

    // Keyboard: Tab from the last header button lands on today; the day line shows its date and count.
    // The Tab stop is the renderer's today: skipped only in the known divergence hour (logged by appDays).
    const todayKey = localDay(today)
    if (!divergent) {
      const dayLine = byTestId('contribution-day')
      await focus('[data-testid="reviews-refresh"]')
      await browser.keys('Tab')
      await expectFocusedDay(todayKey)
      await expect(dayLine).toHaveText(`${shortDateText(todayKey, 'es')} · ${countText(GITHUB_TODAY_COUNT, 'es')}`)
      // Up is the day before (down the day after, a future day with only its date, on the 1st); then back.
      const back = today.getDate() > 1
      const neighbour = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + (back ? -1 : 1)))
      await browser.keys(back ? 'ArrowUp' : 'ArrowDown')
      await expectFocusedDay(neighbour)
      await expect(dayLine).toHaveText(
        back ? `${shortDateText(neighbour, 'es')} · ${countText(github.counts.get(neighbour)!, 'es')}` : shortDateText(neighbour, 'es'),
      )
      await browser.keys(back ? 'ArrowDown' : 'ArrowUp')
      await expectFocusedDay(todayKey)
      // Left/right move a week (when that day is still in the month); the view stays on its platform.
      const step = today.getDate() > 7 ? -7 : 7
      const weekAway = new Date(today.getFullYear(), today.getMonth(), today.getDate() + step)
      if (weekAway.getMonth() === today.getMonth()) {
        await browser.keys(step < 0 ? 'ArrowLeft' : 'ArrowRight')
        await expectFocusedDay(localDay(weekAway))
        await expect(panel()).toHaveAttribute('data-platform', 'github')
      }
      // Tab leaves the chart: the "Actualizado" line is back.
      await browser.keys('Tab')
      await dayLine.waitForExist({ reverse: true })
      await expect(byTestId('contributions-updated')).toBeDisplayed()
    }

    // Back on the panel a minute later: its 60 s minimum is over, so it asks once more.
    await advanceClock(PANEL_REFRESH_MS)
    await closeReviewsView()
    await expectContributionHits(server, { github: 3, gitlab: 3 })
    await eventually(async () => server.hits['gitlab events'], (n) => n === 6, 'six pages of GitLab events')
    await browser.pause(300)

    // GitLab: one square per event (a push is 1), the summary's commits are the pushes' commit_count.
    await clickCard('integration-gitlab')
    await eventually(() => panel().getAttribute('data-platform'), (value) => value === 'gitlab', 'the gitlab view')
    await expectProfile('GitLab', GITLAB_ACCOUNT, 'Abrir GitLab')
    const gitlab = expectedGitlabContributions(today)
    // Today in the fixture: pushes of 1-3 commits plus one of GITLAB_BIG_PUSH_COMMITS, an MR opened,
    // approved, commented on and accepted, an issue opened and commented on, and a "joined".
    expect(gitlab.today).toMatchObject({ opened: 1, merged: 1, reviews: 2 })
    expect(gitlab.today.commits).toBeGreaterThanOrEqual(gitlab.counts.get(todayKey)! - 7 + GITLAB_BIG_PUSH_COMMITS)
    await expectContributions(gitlab, 'es')
    if (!divergent) {
      await expect(graph().$(`[data-date="${todayKey}"]`)).toHaveAttribute(
        'aria-label',
        `${shortDateText(todayKey, 'es')} · ${countText(gitlab.counts.get(todayKey)!, 'es')}`,
      )
    }
    await expect(byTestId('contributions-total')).toHaveAttribute('title', 'En el gráfico un push cuenta 1; el resumen cuenta commits')
    expect(await $$('[data-testid="contributions-restricted"]')).toHaveLength(0)
    expect(await $$('[data-testid="contributions-partial"]')).toHaveLength(0)

    await setLanguage('en')
    await expectProfile('GitLab', GITLAB_ACCOUNT, 'Open GitLab')
    await expectContributions(gitlab, 'en')
    await setLanguage('es')
    await expectProfile('GitLab', GITLAB_ACCOUNT, 'Abrir GitLab')

    // Each opening of the view asks again (the GitLab card reopened it): one for GitHub, one for GitLab.
    expect(contributionHits(server)).toEqual({ github: 4, gitlab: 4 })
    // While open: one more query per platform every 15 min (test clock).
    await advanceClock(CONTRIBUTIONS_TICK_MS)
    await expectContributionHits(server, { github: 5, gitlab: 5 })
    await eventually(async () => server.hits['gitlab events'], (n) => n === 10, 'ten pages of GitLab events')

    // Back on the panel: its own query, the last one. No more across two 15-min steps (the 120 s lists keep going).
    await closeReviewsView()
    expect(await mode()).not.toBe('reviews')
    await expectContributionHits(server, { github: 6, gitlab: 6 })
    const fetches = server.hits['github fetch'] ?? 0
    await advanceClock(CONTRIBUTIONS_TICK_MS)
    await advanceClock(CONTRIBUTIONS_TICK_MS)
    await eventually(async () => server.hits['github fetch'] ?? 0, (n) => n > fetches, 'more GitHub list queries')
    await browser.pause(1_000)
    expect(contributionHits(server)).toEqual({ github: 6, gitlab: 6 })

    expect(server.violations).toEqual([])
    // No event title, branch, commit or note text in the log (only counts and codes).
    expectCleanLogs()
  })

  it('a contributions failure shows "No se pudieron cargar las contribuciones · Reintentar" while the account row still shows; Reintentar recovers', async () => {
    const server = fake!
    await connected(server)
    server.contributionsFail.github = true
    server.contributionsFail.gitlab = true

    await openReviewsView()
    const error = byTestId('contributions-error')
    await expect(error).toHaveText(/^No se pudieron cargar las contribuciones\s*·\s*Reintentar$/)
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'error')
    // The grey chart without data (not a grid) and "—" in the summary; the account row is there.
    expect(await graph().$$('[role="grid"]')).toHaveLength(0)
    await expect($('[data-row="commits"] [data-column="today"]')).toHaveText('—')
    await expectProfile('GitHub', FAKE_GITHUB_LOGIN, 'Abrir GitHub')
    expect(await $$('[data-testid="reviews-status"]')).toHaveLength(0)
    await switchReviewsPlatform('gitlab')
    await expect(error).toBeDisplayed()
    await expectProfile('GitLab', GITLAB_ACCOUNT, 'Abrir GitLab')
    expect(server.hits['github contributions 500']).toBeGreaterThanOrEqual(1)
    expect(server.hits['gitlab contributions 500']).toBeGreaterThanOrEqual(1)
    await switchReviewsPlatform('github')
    await expect(error).toBeDisplayed()

    // The servers recover; Reintentar, once the 5 s rest since opening is over, asks both platforms again.
    server.contributionsFail.github = false
    server.contributionsFail.gitlab = false
    const before = contributionHits(server)
    await advanceClock(REFRESH_REST_MS)
    await byTestId('contributions-retry').click()
    await expectContributionHits(server, { github: before.github + 1, gitlab: before.gitlab + 1 })
    await error.waitForExist({ reverse: true })
    await expect(contributionsBlock()).toHaveAttribute('data-phase', 'ready')
    const today = await appToday()
    await expectContributions(expectedGithubContributions(today), 'es')
    await switchReviewsPlatform('gitlab')
    await error.waitForExist({ reverse: true })
    await expectContributions(expectedGitlabContributions(today), 'es')

    expect(server.violations).toEqual([])
    expectCleanLogs()
  })
})
