import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import {
  FAKE_GITHUB_LOGIN,
  FAKE_GITHUB_TOKEN,
  FAKE_GITLAB_ORIGIN,
  FAKE_GITLAB_TOKEN,
  FAKE_GITLAB_USER,
  GITHUB_MINE,
  GITHUB_TO_REVIEW,
  GITLAB_MINE,
  GITLAB_TO_REVIEW,
  SENSITIVE_DATA,
  githubPrUrl,
  githubRef,
  gitlabMrUrl,
  gitlabRef,
  startFakeCodeReview,
  type FakeCodeReview,
} from './fixtures/fake-code-review'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }
/** Where the replaced `shell.openExternal` keeps the URLs main asked to open. */
type OpenedHost = { __notchOpened?: string[] }
type TestClockHost = { __notchTestClock: { advance: (ms: number) => Promise<void> } }

/** The 120 s query rhythm of both platforms. */
const TICK_MS = 120_000

let userData: string
let launched: ElectronApplication | undefined
let fake: FakeCodeReview | undefined

/** Settings v6: nothing connected yet (GitLab without a server), alerts on but silent. */
const writeSettings = (): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 6,
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
    }),
    'utf8',
  )
}

const launch = async (server: FakeCodeReview): Promise<{ app: ElectronApplication; notch: Page }> => {
  writeSettings()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Dev-only clock: moving it forward fires the 120 s GitHub/GitLab query at once (ignored when packaged).
  env['NOTCH_TEST_CLOCK'] = '1'
  // Stay isolated from an installed notch and from the real ~/.claude/settings.json.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  // GitHub's API and the GitLab server are the local fake (settings still hold an https GitLab URL).
  env['NOTCH_CODE_REVIEW_BASE_URLS'] = `github=${server.base},gitlab=${server.base}`
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

/** Moves the dev-only test clock: a code-review query that falls due runs now. */
const advance = (app: ElectronApplication, ms: number) =>
  app.evaluate(async (_electron, delta) => {
    await (globalThis as unknown as TestClockHost).__notchTestClock.advance(delta)
  }, ms)

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')
const setLanguage = (notch: Page, language: 'es' | 'en') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)
const request = (notch: Page, intent: 'expand' | 'dismiss') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: value }), intent)

const openControlCenter = async (app: ElectronApplication, notch: Page): Promise<Page> => {
  const opened = app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter({ page: 'code-review' }))
  const cc = await opened
  await cc.waitForLoadState('domcontentloaded')
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  await expect(cc.getByTestId('code-review-page')).toBeVisible()
  return cc
}

/** Every input value of a window: a saved token must not linger in any of them. */
const inputValues = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    type Doc = { querySelectorAll: (selector: string) => Iterable<{ value: string }> }
    return [...(globalThis as unknown as { document: Doc }).document.querySelectorAll('input, textarea')].map((el) => el.value)
  })

/** The token never stays in a window: not in the markup, not in any field's value. */
const expectNoTokenInDom = async (page: Page): Promise<void> => {
  const html = await page.content()
  const values = (await inputValues(page)).join('\n')
  for (const token of [FAKE_GITHUB_TOKEN, FAKE_GITLAB_TOKEN]) {
    expect(html, 'token in the markup').not.toContain(token)
    expect(values, 'token in a field').not.toContain(token)
  }
}

/** "Comprobar y guardar" on one card; the account shows and the token field is emptied. */
const saveToken = async (cc: Page, platform: 'github' | 'gitlab', token: string, url?: string): Promise<void> => {
  const card = cc.getByTestId(`code-review-${platform}`)
  if (url !== undefined) await card.getByLabel('URL de GitLab').fill(url)
  const field = card.getByLabel(platform === 'github' ? 'Token de GitHub' : 'Token de GitLab')
  await field.fill(token)
  await expect(field).toHaveAttribute('type', 'password')
  await card.getByRole('button', { name: 'Comprobar y guardar' }).click()
}

const connectBoth = async (cc: Page): Promise<void> => {
  await saveToken(cc, 'github', FAKE_GITHUB_TOKEN)
  await expect(cc.getByTestId('code-review-github-status').locator('span')).toHaveText(`Conectado como ${FAKE_GITHUB_LOGIN}`)
  await saveToken(cc, 'gitlab', FAKE_GITLAB_TOKEN, FAKE_GITLAB_ORIGIN)
  await expect(cc.getByTestId('code-review-gitlab-status').locator('span')).toHaveText(`Conectado como ${FAKE_GITLAB_USER.username}`)
}

/** Launch, connect both platforms from the Control Center; the capsule shows GitHub 2 and GitLab 1. */
const connected = async (server: FakeCodeReview): Promise<{ app: ElectronApplication; notch: Page; cc: Page }> => {
  const { app, notch } = await launch(server)
  const cc = await openControlCenter(app, notch)
  await connectBoth(cc)
  await expect(notch.getByTestId('metric-review-github')).toHaveAttribute('aria-label', '2 PR tuyos sin revisar en GitHub')
  await expect(notch.getByTestId('metric-review-gitlab')).toHaveAttribute('aria-label', '1 MR tuyo sin revisar en GitLab')
  return { app, notch, cc }
}

const openReviewsView = async (notch: Page): Promise<void> => {
  await request(notch, 'expand')
  await notch.getByTestId('integration-reviews').click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'reviews')
  await expect(notch.getByTestId('reviews-panel')).toBeVisible()
}

const rowsOf = (notch: Page, section: 'toReview' | 'mine'): Locator => notch.locator(`[data-section="${section}"] [data-testid="review-item"]`)
const badgesOf = (row: Locator): Promise<(string | null)[]> =>
  row.locator('[data-badge]').evaluateAll((els) => els.map((el) => el.getAttribute('data-badge')))

/** The title sits on line 1, above the ref (line 2). */
const expectTitleOnFirstLine = async (row: Locator): Promise<void> => {
  const title = await row.getByTestId('review-title').boundingBox()
  const ref = await row.getByTestId('review-ref').boundingBox()
  expect(title && ref && title.y + title.height <= ref.y + 1).toBe(true)
}

/** Whether main has the notch window on screen (not just its renderer state). */
const notchWindowVisible = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !w.webContents.getURL().includes('control-center') && w.isVisible()),
  )

/** Every log line main wrote so far. */
const readLogs = (): string =>
  readdirSync(join(userData, 'logs'))
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(userData, 'logs', name), 'utf8'))
    .join('\n')

/** No token, title, repository, author or account in the log, nor any token in plain text in userData. */
const expectCleanLogs = (): void => {
  const logs = readLogs()
  expect(logs).toContain('code-review') // the integration did log (states and counts)
  for (const piece of SENSITIVE_DATA) expect(logs, 'code-review data in the log').not.toContain(piece)
  for (const name of readdirSync(userData)) {
    const file = join(userData, name)
    if (!statSync(file).isFile()) continue
    const content = readFileSync(file).toString('latin1')
    for (const token of [FAKE_GITHUB_TOKEN, FAKE_GITLAB_TOKEN]) expect(content, `plain token in ${name}`).not.toContain(token)
  }
}

const screenshot = async (page: Page, name: string): Promise<void> => {
  await settle(page)
  await page.screenshot({ path: `test-results/${name}` })
}

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-code-review-'))
  fake = await startFakeCodeReview()
})

test.afterEach(async () => {
  // A failed test must not leave Electron holding the temp profile, nor the fake server listening.
  await launched?.close().catch(() => undefined)
  launched = undefined
  await fake?.close().catch(() => undefined)
  fake = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('save tokens in Control Center, counts in the capsule, the view with tabs and sections, open in the browser', async () => {
  const server = fake!
  const { app, notch } = await launch(server)
  const cc = await openControlCenter(app, notch)
  await expect(cc.getByTestId('code-review-github-status')).toHaveAttribute('data-status', 'unconfigured')
  await expect(cc.getByTestId('code-review-gitlab-status')).toHaveAttribute('data-status', 'unconfigured')
  // Nothing configured: nothing is asked of either platform, no block in the capsule.
  expect(server.requests).toEqual({ github: 0, gitlab: 0 })
  await expect(notch.getByTestId('metric-review-github')).toHaveCount(0)

  // GitHub: the token is checked against the API, the account shows, the field is emptied.
  await saveToken(cc, 'github', FAKE_GITHUB_TOKEN)
  await expect(cc.getByTestId('code-review-github-status').locator('span')).toHaveText(`Conectado como ${FAKE_GITHUB_LOGIN}`)
  await expect(cc.getByTestId('code-review-github').getByLabel('Token de GitHub')).toHaveValue('')
  expect(server.hits['github viewer']).toBe(1)

  // GitLab: a plain-http server is refused before anything is sent.
  await saveToken(cc, 'gitlab', FAKE_GITLAB_TOKEN, 'http://gitlab.example.test')
  await expect(cc.getByTestId('code-review-gitlab-error')).toHaveText('La URL debe empezar por https://')
  await expect(cc.getByTestId('code-review-gitlab-status')).toHaveAttribute('data-status', 'unconfigured')
  expect(server.requests.gitlab).toBe(0)
  // The https server is accepted and saved (normalized) in settings; the token never is.
  await cc.getByTestId('code-review-gitlab').getByLabel('URL de GitLab').fill(FAKE_GITLAB_ORIGIN)
  await cc.getByTestId('code-review-gitlab').getByRole('button', { name: 'Comprobar y guardar' }).click()
  await expect(cc.getByTestId('code-review-gitlab-status').locator('span')).toHaveText(`Conectado como ${FAKE_GITLAB_USER.username}`)
  await expect(cc.getByTestId('code-review-gitlab').getByLabel('Token de GitLab')).toHaveValue('')
  await expect(cc.getByTestId('code-review-gitlab-error')).toHaveCount(0)
  await expect.poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).codeReview.gitlabUrl).toBe(FAKE_GITLAB_ORIGIN)
  await expectNoTokenInDom(cc)

  // Settings page, both connected (the window is Mica: give the capture the dark backdrop it has on screen).
  await cc.addStyleTag({ content: 'html, body { background: #0d0d0f !important }' })
  await cc.locator('main').evaluate((el) => el.scrollTo(0, 0))
  await screenshot(cc, 'code-review-settings.png')

  // The capsule: one block per platform with its own unreviewed PR/MRs (drafts and reviewed ones left out).
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  const github = notch.getByTestId('metric-review-github')
  const gitlab = notch.getByTestId('metric-review-gitlab')
  await expect(github).toHaveAttribute('aria-label', '2 PR tuyos sin revisar en GitHub')
  await expect(gitlab).toHaveAttribute('aria-label', '1 MR tuyo sin revisar en GitLab')
  await expect(github).toContainText('2')
  await expect(gitlab).toContainText('1')
  await screenshot(notch, 'code-review-capsule-es.png')

  // The view: tabs for the two platforms, GitHub first, "Por revisar" (3) and "Míos" (4).
  await openReviewsView(notch)
  const githubTab = notch.getByRole('tab', { name: 'GitHub' })
  const gitlabTab = notch.getByRole('tab', { name: 'GitLab' })
  await expect(githubTab).toHaveAttribute('aria-selected', 'true')
  await expect(gitlabTab).toHaveAttribute('aria-selected', 'false')
  await expect(notch.getByTestId('reviews-panel')).toHaveAttribute('data-platform', 'github')
  await expect(rowsOf(notch, 'toReview')).toHaveCount(3)
  await expect(rowsOf(notch, 'mine')).toHaveCount(4)
  await expect(notch.locator('#reviews-section-toReview')).toHaveText(/^Por revisar\s*3$/)
  await expect(notch.locator('#reviews-section-mine')).toHaveText(/^Míos\s*4$/)

  // Rows: title on line 1; ref, author (to review only) and labels on line 2.
  for (const [index, pr] of GITHUB_TO_REVIEW.entries()) {
    const row = rowsOf(notch, 'toReview').nth(index)
    await expect(row.getByTestId('review-title')).toHaveText(pr.title)
    await expect(row.getByTestId('review-ref')).toHaveText(githubRef(pr))
    await expect(row).toContainText(`de ${pr.author}`)
    await expectTitleOnFirstLine(row)
  }
  expect(await badgesOf(rowsOf(notch, 'toReview').nth(0))).toEqual(['checksPass'])
  expect(await badgesOf(rowsOf(notch, 'toReview').nth(1))).toEqual(['conflicts', 'checksFail'])
  expect(await badgesOf(rowsOf(notch, 'toReview').nth(2))).toEqual(['checksRunning'])
  for (const [index, pr] of GITHUB_MINE.entries()) {
    const row = rowsOf(notch, 'mine').nth(index)
    await expect(row.getByTestId('review-title')).toHaveText(pr.title)
    await expect(row.getByTestId('review-ref')).toHaveText(githubRef(pr))
    await expect(row).not.toContainText(`de ${pr.author}`)
  }
  expect(await badgesOf(rowsOf(notch, 'mine').nth(0))).toEqual(['unreviewed', 'checksPass'])
  expect(await badgesOf(rowsOf(notch, 'mine').nth(1))).toEqual(['unreviewed', 'checksRunning'])
  expect(await badgesOf(rowsOf(notch, 'mine').nth(2))).toEqual(['approved', 'checksPass'])
  expect(await badgesOf(rowsOf(notch, 'mine').nth(3))).toEqual(['draft'])
  await expect(rowsOf(notch, 'mine').nth(0)).toContainText('Sin revisar')
  await expect(rowsOf(notch, 'mine').nth(3)).toContainText('Borrador')
  // The click on the tile left the (page) pointer over a row: rest it on the title instead.
  await notch.getByTestId('reviews-panel').locator('h2').hover()
  await screenshot(notch, 'code-review-view-es.png')

  await setLanguage(notch, 'en')
  await expect(notch.locator('#reviews-section-toReview')).toHaveText(/^To review\s*3$/)
  await expect(rowsOf(notch, 'mine').nth(0)).toContainText('Unreviewed')
  await screenshot(notch, 'code-review-view-en.png')
  await setLanguage(notch, 'es')
  await expect(notch.locator('#reviews-section-toReview')).toHaveText(/^Por revisar\s*3$/)

  // A row opens the PR in the browser: main looks the URL up by id (the renderer never has it).
  await rowsOf(notch, 'toReview').nth(0).click()
  await expect.poll(() => openedUrls(app)).toContain(githubPrUrl(GITHUB_TO_REVIEW[0]!))
  // Enter on a focused row opens it too.
  await rowsOf(notch, 'mine').nth(1).focus()
  await notch.keyboard.press('Enter')
  await expect.poll(() => openedUrls(app)).toContain(githubPrUrl(GITHUB_MINE[1]!))

  // GitLab tab: "Por revisar" (2) and "Míos" (3); refs with `!`, the draft labelled.
  await gitlabTab.click()
  await expect(gitlabTab).toHaveAttribute('aria-selected', 'true')
  await expect(notch.getByTestId('reviews-panel')).toHaveAttribute('data-platform', 'gitlab')
  await expect(rowsOf(notch, 'toReview')).toHaveCount(2)
  await expect(rowsOf(notch, 'mine')).toHaveCount(3)
  for (const [index, mr] of GITLAB_TO_REVIEW.entries()) {
    const row = rowsOf(notch, 'toReview').nth(index)
    await expect(row.getByTestId('review-title')).toHaveText(mr.title)
    await expect(row.getByTestId('review-ref')).toHaveText(gitlabRef(mr))
    await expect(row).toContainText(`de ${mr.author}`)
  }
  expect(await badgesOf(rowsOf(notch, 'toReview').nth(0))).toEqual(['checksPass'])
  expect(await badgesOf(rowsOf(notch, 'toReview').nth(1))).toEqual(['conflicts', 'checksRunning'])
  for (const [index, mr] of GITLAB_MINE.entries()) {
    await expect(rowsOf(notch, 'mine').nth(index).getByTestId('review-ref')).toHaveText(gitlabRef(mr))
    await expect(rowsOf(notch, 'mine').nth(index).getByTestId('review-title')).toContainText(mr.title)
  }
  expect(await badgesOf(rowsOf(notch, 'mine').nth(0))).toEqual(['unreviewed', 'checksPass'])
  expect(await badgesOf(rowsOf(notch, 'mine').nth(1))).toEqual(['approved', 'checksFail'])
  expect(await badgesOf(rowsOf(notch, 'mine').nth(2))).toEqual(['draft'])
  await rowsOf(notch, 'mine').nth(0).click()
  await expect.poll(() => openedUrls(app)).toContain(gitlabMrUrl(GITLAB_MINE[0]!))

  // Only PR/MR pages on github.com and the configured GitLab origin were ever opened.
  const opened = await openedUrls(app)
  expect(opened).toHaveLength(3)
  for (const url of opened) expect(url.startsWith('https://github.com/') || url.startsWith(`${FAKE_GITLAB_ORIGIN}/`), url).toBe(true)

  // No token in any window; the protocol was spoken right (headers, queries, no per-MR call for the draft).
  await expectNoTokenInDom(notch)
  await expectNoTokenInDom(cc)
  expect(server.violations).toEqual([])
  expect(server.hits['github fetch']).toBeGreaterThanOrEqual(1)
  expect(server.hits['gitlab mine']).toBeGreaterThanOrEqual(1)
  expect(server.hits['gitlab approvals']).toBeGreaterThanOrEqual(2)
  expectCleanLogs()
})

test('a first review shows the alert (also over a capsule hidden with "Ocultar") and lowers the count', async () => {
  const server = fake!
  const { app, notch, cc } = await connected(server)
  await cc.close()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')

  // Someone approves one of the user's PRs; the next 120 s query (test clock) sees its first review.
  const [first] = GITHUB_MINE
  server.reviewPr(first!.id, 'approved')
  await advance(app, TICK_MS)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  const alert = notch.getByTestId('review-alert')
  const shownAt = Date.now()
  await expect(alert).toHaveText(`Aprobado · web-app#${first!.number} · ${first!.title}`)
  await expect(alert).toHaveAttribute('aria-live', 'polite')
  await screenshot(notch, 'code-review-alert-es.png')
  // It ends on its own after about 6 s; the GitHub count went down by one.
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact', { timeout: 12_000 })
  expect(Date.now() - shownAt).toBeGreaterThan(4_000)
  await expect(notch.getByTestId('metric-review-github')).toHaveAttribute('aria-label', '1 PR tuyo sin revisar en GitHub')
  await expect(notch.getByTestId('metric-review-gitlab')).toHaveAttribute('aria-label', '1 MR tuyo sin revisar en GitLab')

  // The user hides the notch ("Ocultar"): the window leaves the screen, the queries go on.
  await request(notch, 'expand')
  await notch.getByRole('button', { name: 'Ocultar', exact: true }).click()
  await expect(capsule(notch)).toHaveCount(0)
  await expect.poll(() => notchWindowVisible(app)).toBe(false)

  // Changes are requested on the user's GitLab MR: the alert shows over the hidden capsule, then hides again.
  const [mr] = GITLAB_MINE
  server.reviewMr(mr!.iid, 'changes')
  await advance(app, TICK_MS)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  await expect(alert).toHaveText(`Cambios pedidos · frontend!${mr!.iid} · ${mr!.title}`)
  expect(await notchWindowVisible(app)).toBe(true)
  await expect(capsule(notch)).toHaveCount(0, { timeout: 12_000 })
  await expect.poll(() => notchWindowVisible(app)).toBe(false)

  // Shown again: GitHub still has one unreviewed PR.
  await request(notch, 'expand')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  await notch.mouse.move(1, 1)
  await request(notch, 'dismiss')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('metric-review-github')).toHaveAttribute('aria-label', '1 PR tuyo sin revisar en GitHub')

  // A later query with nothing new alerts nothing; GitLab has nothing unreviewed left, so its block
  // is gone at once (a live 0 does not linger).
  const gitlab = notch.getByTestId('metric-review-gitlab')
  await advance(app, TICK_MS)
  await notch.waitForTimeout(500)
  await expect(gitlab).toHaveCount(0)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('review-alert')).toHaveCount(0)

  expect(server.violations).toEqual([])
  expectCleanLogs()
})

test('a rejected token (401) shows "Revisa el token" in the view and the Control Center and stops querying that platform', async () => {
  const server = fake!
  const { app, notch, cc } = await connected(server)
  await openReviewsView(notch)
  await expect(rowsOf(notch, 'toReview')).toHaveCount(3)

  // GitHub now refuses the token (expired or revoked); the next query finds out.
  server.unauthorized.github = true
  await advance(app, TICK_MS)
  const status = notch.getByTestId('reviews-status')
  await expect(status).toHaveAttribute('data-notice', 'auth')
  await expect(status).toContainText('Revisa el token en Control Center')
  await expect(notch.getByTestId('review-item')).toHaveCount(0)
  await expect(notch.getByTestId('reviews-open-control-center')).toBeVisible()
  await expect(cc.getByTestId('code-review-github-status')).toHaveAttribute('data-status', 'auth-error')
  await expect(cc.getByTestId('code-review-github-status')).toContainText('Revisa el token')
  // GitLab is unaffected: its tab still lists.
  await notch.getByRole('tab', { name: 'GitLab' }).click()
  await expect(rowsOf(notch, 'toReview')).toHaveCount(2)

  // No more GitHub requests: not on the rhythm, not on a refresh. GitLab keeps going.
  const githubBefore = server.requests.github
  const gitlabBefore = server.requests.gitlab
  await advance(app, TICK_MS)
  await advance(app, TICK_MS)
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.codeReview.refresh())
  await expect.poll(() => server.requests.gitlab).toBeGreaterThan(gitlabBefore)
  await notch.waitForTimeout(1_000)
  expect(server.requests.github).toBe(githubBefore)

  // GitLab too: both cards ask for a new token; the capsule has no review block left.
  server.unauthorized.gitlab = true
  await advance(app, TICK_MS)
  await expect(cc.getByTestId('code-review-gitlab-status')).toHaveAttribute('data-status', 'auth-error')
  await expect(status).toHaveAttribute('data-notice', 'auth')
  const gitlabAfter = server.requests.gitlab
  await advance(app, TICK_MS)
  await notch.waitForTimeout(1_000)
  expect(server.requests.gitlab).toBe(gitlabAfter)
  await notch.keyboard.press('Escape')
  await notch.mouse.move(1, 1)
  await request(notch, 'dismiss')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('metric-review-github')).toHaveCount(0)
  await expect(notch.getByTestId('metric-review-gitlab')).toHaveCount(0)

  // A new valid token brings GitHub back.
  server.unauthorized.github = false
  await saveToken(cc, 'github', FAKE_GITHUB_TOKEN)
  await expect(cc.getByTestId('code-review-github-status').locator('span')).toHaveText(`Conectado como ${FAKE_GITHUB_LOGIN}`)
  await expect(notch.getByTestId('metric-review-github')).toHaveAttribute('aria-label', '2 PR tuyos sin revisar en GitHub')

  expect(server.violations).toEqual([])
  expectCleanLogs()
})
