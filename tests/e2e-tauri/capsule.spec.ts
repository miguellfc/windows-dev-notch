/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The compact capsule in three zones (0.3.0): time and date | the integration blocks | the system.
// The worst case is real data end to end: Claude sessions POSTed to the bridge, and Gmail, GitHub,
// GitLab and Redmine connected from the Control Center against the strict fakes of
// tests/e2e-tauri/fixtures (never the real services; URLs are recorded, never opened). Each test
// checks Spanish first, then switches the same app to English and checks again.
//
// Hover is `pointer()` (`__e2e:pointer`), as in the other Tauri specs. GAP: the Control Center stays
// open after connecting (no close channel, as in code-review.spec.ts); WebDriver switches back to
// the notch. GAP: the disk alert can only be forced up to its 50 % threshold, so whether the
// storage block shows it depends on the machine; the spec logs it and checks the width either way.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, expect } from '@wdio/globals'
import { compactWidthFor } from '../../src/shared/notch/geometry'
import {
  FAKE_GITHUB_LOGIN,
  FAKE_GITHUB_TOKEN,
  FAKE_GITLAB_ORIGIN,
  FAKE_GITLAB_TOKEN,
  FAKE_GITLAB_USER,
  startFakeCodeReview,
  type FakeCodeReview,
} from './fixtures/fake-code-review'
import { FAKE_ACCOUNT, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGmail, type FakeGmail } from './fixtures/fake-gmail'
import { FAKE_REDMINE_ACCOUNT, FAKE_REDMINE_KEY, FAKE_REDMINE_ORIGIN, startFakeRedmine, type FakeRedmine } from './fixtures/fake-redmine'
import {
  DEFAULT_ALERTS,
  alignZoneWithWindows,
  capsuleBox,
  dataDir,
  e2e,
  eventually,
  fillValue,
  hookEvent,
  inPage,
  installClaudeHooks,
  labelledField,
  launch,
  launchClaude,
  openControlCenter,
  openedUrls,
  pointer,
  postHook,
  present,
  quitApp,
  seededSettings,
  setLanguage,
  settle,
  useWindow,
  type ClaudeBridge,
} from './helpers'

const capsule = () => $('[data-testid="notch-capsule"]')
const mode = () => capsule().getAttribute('data-mode')
const expectMode = (value: string) => eventually(mode, (current) => current === value, `data-mode=${value}`)
const count = async (selector: string): Promise<number> => (await $$(selector)).length

/** The visible text (`innerText`: not a block's invisible reserved width) of the first match, whitespace collapsed; null when absent. */
const textOf = (selector: string): Promise<string | null> =>
  inPage((sel: string) => {
    const el = (globalThis as unknown as { document: { querySelector(s: string): { innerText: string } | null } }).document.querySelector(sel)
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
  }, selector)

const labelOf = (selector: string): Promise<string | null> =>
  inPage(
    (sel: string) =>
      (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document
        .querySelector(sel)
        ?.getAttribute('aria-label') ?? null,
    selector,
  )

interface Box {
  id: string
  scrollWidth: number
  clientWidth: number
  /** Distances from the capsule's edges (negative: past the edge). */
  left: number
  right: number
  top: number
  bottom: number
}

/** Every zone and block of the present copy of the compact capsule, measured against the capsule. */
const measureCompact = (): Promise<Box[]> =>
  inPage(() => {
    type R = { left: number; right: number; top: number; bottom: number }
    type El = {
      getAttribute(n: string): string | null
      getBoundingClientRect(): R
      closest(s: string): unknown
      scrollWidth: number
      clientWidth: number
    }
    const doc = (globalThis as unknown as { document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> } }).document
    const cap = doc.querySelector('[data-testid="notch-capsule"]')!.getBoundingClientRect()
    return Array.from(doc.querySelectorAll('[data-testid^="capsule-zone-"], [data-testid^="metric-"], [data-testid="claude-dots"]'))
      .filter((el) => el.closest('[aria-hidden="true"]') === null)
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-testid') ?? '',
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          left: r.left - cap.left,
          right: cap.right - r.right,
          top: r.top - cap.top,
          bottom: cap.bottom - r.bottom,
        }
      })
  })

/** The width compactWidthFor gives for what the capsule shows right now. */
async function expectedCompactWidth(): Promise<number> {
  const system = (await count(present('capsule-zone-system'))) > 0
  return compactWidthFor({
    system: system ? { battery: (await count(present('metric-battery'))) > 0 } : null,
    blocks: {
      claude: (await count(present('claude-dots'))) > 0,
      mail: (await count(present('metric-mail'))) > 0,
      reviews: ((await count(present('metric-review-github'))) + (await count(present('metric-review-gitlab')))) as 0 | 1 | 2,
      redmine: (await count(present('metric-redmine'))) > 0,
      workLog: (await count(present('metric-work-log'))) > 0,
    },
  })
}

/**
 * Nothing in the compact capsule overflows: every zone and block fits its own box, stays inside the
 * capsule's padding (14 px + its 1 px border) and the zones follow one another without overlapping;
 * the capsule is as wide as compactWidthFor says (±1 px).
 */
async function expectCompactFits(ids: string[]): Promise<void> {
  // The system zone waits for the first sample.
  for (const id of ids) await $(present(id)).waitForExist({ timeout: 15_000 })
  await settle()
  const boxes = await measureCompact()
  for (const id of ids) expect({ id, present: boxes.some((box) => box.id === id) }).toEqual({ id, present: true })
  for (const box of boxes) {
    expect({ id: box.id, fits: box.clientWidth > 0 && box.scrollWidth <= box.clientWidth }).toEqual({ id: box.id, fits: true })
    expect({ id: box.id, inside: box.left >= 14.5 && box.right >= 14.5 && box.top >= 0 && box.bottom >= 0 }).toEqual({ id: box.id, inside: true })
  }
  const zones = boxes.filter((box) => box.id.startsWith('capsule-zone-')).sort((a, b) => a.left - b.left)
  expect(zones.map((zone) => zone.id)).toEqual(['capsule-zone-left', 'capsule-zone-blocks', 'capsule-zone-system'].filter((id) => zones.some((zone) => zone.id === id)))
  const width = (await capsuleBox()).width
  for (let i = 1; i < zones.length; i++) {
    // Right edge of the previous zone (its distance from the capsule's left) against this zone's left.
    expect(width - zones[i - 1]!.right).toBeLessThanOrEqual(zones[i]!.left + 0.5)
  }
  expect(Math.abs(width - (await expectedCompactWidth()))).toBeLessThanOrEqual(1)
}

/** Alerts that would take the capsule out of compact stay off; the disk alert at its highest threshold. */
const settings = () => ({
  ...seededSettings({ ...DEFAULT_ALERTS, disk: { enabled: true, freePercent: 50 } }),
  gmail: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, alerts: { enabled: false, hideContent: false, sound: false } },
  codeReview: { gitlabUrl: '', alerts: { github: { enabled: false, sound: false }, gitlab: { enabled: false, sound: false } } },
  redmine: { url: '', dailyTargetHours: 8, endOfDay: { enabled: false, time: '18:00', sound: false } },
})

/** "Comprobar y guardar" on a Control Center card after filling its labelled fields (WebDriver on it). */
async function saveCard(scope: string, fields: Record<string, string>): Promise<void> {
  for (const [label, value] of Object.entries(fields)) await fillValue(await labelledField(scope, label), value)
  await $(scope).$('.//button[normalize-space()="Comprobar y guardar"]').click()
}

const expectStatus = (selector: string, text: string) =>
  eventually(() => textOf(selector), (value) => value !== null && value.includes(text), `${selector} containing "${text}"`, 15_000)

/** Gmail's sign-in through the fake Google, playing the browser (as gmail.spec.ts). WebDriver on the Control Center. */
async function signInGmail(server: FakeGmail): Promise<void> {
  const before = (await openedUrls()).length
  await $('[data-testid="gmail-session"]').$('.//button[normalize-space()="Iniciar sesión"]').click()
  const consent = await eventually(
    async () => (await openedUrls()).slice(before).find((url) => url.startsWith(`${server.base}/o/oauth2/v2/auth?`)) ?? '',
    (url) => url !== '',
    'the consent URL',
  )
  const consented = await fetch(consent, { redirect: 'manual' })
  expect(consented.status).toBe(302)
  const back = new URL(consented.headers.get('location') ?? '')
  // Only ever the app's own loopback.
  expect(back.hostname).toBe('127.0.0.1')
  expect((await fetch(back)).status).toBe(200)
  await expectStatus('[data-testid="gmail-session"]', `Conectado como ${FAKE_ACCOUNT}`)
}

/** 14 sessions with a dot: 3 waiting, 3 with an error and 8 working (4 dots and "+10", shown as "+9"). */
async function seedSessions(bridge: ClaudeBridge): Promise<void> {
  const post = async (session: string, name: string, extra: Record<string, unknown> = {}) =>
    expect((await postHook(bridge.hook, hookEvent(session, name, extra))).status).toBe(200)
  for (let i = 0; i < 14; i++) await post(`proyecto-${i}`, 'UserPromptSubmit')
  for (let i = 0; i < 3; i++) await post(`proyecto-${i}`, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })
  for (let i = 3; i < 6; i++) await post(`proyecto-${i}`, 'StopFailure')
}

let gmail: FakeGmail | undefined
let review: FakeCodeReview | undefined
let redmine: FakeRedmine | undefined

describe('Compact capsule (Tauri)', () => {
  after(async () => {
    await quitApp()
    await Promise.all([gmail?.close(), review?.close(), redmine?.close()])
    gmail = review = redmine = undefined
  })

  it('compact capsule worst case fits', async () => {
    // Connecting GitHub and GitLab asks for their month's contributions (their capsule blocks), and
    // the fake checks the ranges against the app's days (see code-review.spec.ts).
    alignZoneWithWindows()
    ;[gmail, review, redmine] = await Promise.all([startFakeGmail(), startFakeCodeReview(), startFakeRedmine()])
    for (const base of [gmail.base, review.base, redmine.base]) {
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) throw new Error(`Unexpected fake origin ${base}`)
    }
    // 3 unread in the seed + 97: "99+".
    for (let i = 0; i < 97; i++) {
      const id = `19e${i.toString(16).padStart(3, '0')}`
      gmail.addMail({ id, threadId: `${id}f0`, from: 'Correo Ficticio <correo@example.com>', sender: 'Correo Ficticio', subject: `Aviso ${i}`, snippet: 'Texto ficticio.' })
    }
    await launchClaude({
      env: {
        NOTCH_GMAIL_BASE_URL: gmail.base,
        NOTCH_CODE_REVIEW_BASE_URLS: `github=${review.base},gitlab=${review.base}`,
        NOTCH_REDMINE_BASE_URL: redmine.base,
        NOTCH_OPEN_URL_LOG: '1',
      },
      files: { 'settings.json': settings() },
    })
    // The recorder must be on before anything is clicked: never a real browser.
    expect(await openedUrls()).toEqual([])
    const bridge = await installClaudeHooks()

    await openControlCenter('code-review')
    await $('[data-testid="code-review-page"]').waitForDisplayed()
    await saveCard('[data-testid="code-review-github"]', { 'Token de GitHub': FAKE_GITHUB_TOKEN })
    await expectStatus('[data-testid="code-review-github-status"]', `Conectado como ${FAKE_GITHUB_LOGIN}`)
    await saveCard('[data-testid="code-review-gitlab"]', { 'URL de GitLab': FAKE_GITLAB_ORIGIN, 'Token de GitLab': FAKE_GITLAB_TOKEN })
    await expectStatus('[data-testid="code-review-gitlab-status"]', `Conectado como ${FAKE_GITLAB_USER.username}`)

    await useWindow('notch')
    await openControlCenter('redmine')
    await $('[data-testid="redmine-page"]').waitForDisplayed()
    await saveCard('[data-testid="redmine-connection"]', { 'URL de Redmine': FAKE_REDMINE_ORIGIN, 'Clave de acceso API': FAKE_REDMINE_KEY })
    await expectStatus('[data-testid="redmine-status"]', `Conectado como ${FAKE_REDMINE_ACCOUNT}`)

    await useWindow('notch')
    await openControlCenter('gmail')
    await $('[data-testid="gmail-page"]').waitForDisplayed()
    await signInGmail(gmail)

    await useWindow('notch')
    await seedSessions(bridge)
    await pointer(true)
    await expectMode('compact')
    for (const id of ['claude-dots', 'metric-mail', 'metric-review-github', 'metric-review-gitlab', 'metric-redmine', 'metric-storage']) {
      await $(present(id)).waitForDisplayed({ timeout: 15_000 })
    }
    await eventually(() => textOf(present('metric-mail')), (text) => text === '99+', 'the mail block at "99+"')
    // 14 sessions with a dot: Claude's mark alone (no dots, no "+N"); the label counts each state.
    await eventually(() => labelOf(present('claude-dots')), (label) => label === 'Claude Code: 8 trabajando, 3 esperando, 3 con error', 'the Claude label')
    expect(await count(`${present('claude-dots')} .status-dot`)).toBe(0)
    console.log(`storage block: "${await textOf(present('metric-storage'))}" (${await labelOf(present('metric-storage'))})`)

    const all = ['capsule-zone-left', 'capsule-zone-blocks', 'capsule-zone-system', 'claude-dots', 'metric-mail', 'metric-review-github', 'metric-review-gitlab', 'metric-redmine', 'metric-cpu', 'metric-ram', 'metric-storage', 'metric-connection']
    await expectCompactFits(all)
    expect(await expectedCompactWidth()).toBe(compactWidthFor({ system: { battery: (await count(present('metric-battery'))) > 0 }, blocks: { claude: true, mail: true, reviews: 2, redmine: true, workLog: false } }))

    await setLanguage('en')
    await eventually(() => labelOf(present('claude-dots')), (label) => label === 'Claude Code: 8 working, 3 waiting, 3 with errors', 'the English Claude label')
    await expectCompactFits(all)
    for (const fake of [gmail, review, redmine]) expect(fake.violations).toEqual([])
  })

  it('storage and connection always show', async () => {
    await launch({ fresh: true, files: { 'settings.json': seededSettings(DEFAULT_ALERTS) } })
    await pointer(true)
    await expectMode('compact')
    const storage = present('metric-storage')
    const connection = present('metric-connection')
    await $(storage).waitForDisplayed({ timeout: 15_000 })
    await $(connection).waitForDisplayed()
    // "62 %": the whole computer's fill (every fixed drive), with no drive letter.
    expect(await textOf(storage)).toMatch(/^\d{1,3}\s?%$/u)
    expect(await labelOf(storage)).toMatch(/^Almacenamiento: \d{1,3}\s?% usado(; poco espacio libre en [A-Z]:)?$/u)
    expect(await labelOf(connection)).toBe('Con conexión')
    await expectCompactFits(['capsule-zone-left', 'capsule-zone-system', 'metric-storage', 'metric-connection'])

    await setLanguage('en')
    await eventually(() => labelOf(connection), (label) => label === 'Online', 'the English connection label')
    expect(await textOf(storage)).toMatch(/^\d{1,3}\s?%$/u)
    expect(await labelOf(storage)).toMatch(/^Storage: \d{1,3}\s?% used(; [A-Z]: is low on space)?$/u)
    await expectCompactFits(['capsule-zone-left', 'capsule-zone-system', 'metric-storage', 'metric-connection'])
  })

  it("the connection icon follows main's internet reading", async () => {
    // `__e2e:connectivity` forces what the monitor reads from Windows' connectivity hint; it shows
    // with the next light sample (every 3 s). navigator.onLine stays true on a network without
    // internet, so only main's reading can turn the icon off here.
    await launch({ fresh: true, files: { 'settings.json': seededSettings(DEFAULT_ALERTS) } })
    await pointer(true)
    await expectMode('compact')
    const connection = present('metric-connection')
    await $(connection).waitForDisplayed({ timeout: 15_000 })
    const state = async () => `${await $(connection).getAttribute('data-online')} ${await labelOf(connection)}`
    const navigatorOnline = () => inPage(() => (globalThis as unknown as { navigator: { onLine: boolean } }).navigator.onLine)

    await e2e('connectivity', { connectivity: 'offline' })
    await eventually(state, (value) => value === 'false Sin conexión', 'the connection offline')
    // Icon only: the width does not move.
    await expectCompactFits(['capsule-zone-left', 'capsule-zone-system', 'metric-storage', 'metric-connection'])

    await e2e('connectivity', { connectivity: 'online' })
    await eventually(state, (value) => value === 'true Con conexión', 'the connection online')

    // Windows does not know: navigator.onLine decides.
    await e2e('connectivity', { connectivity: 'offline' })
    await eventually(state, (value) => value === 'false Sin conexión', 'the connection offline again')
    await e2e('connectivity', { connectivity: 'unknown' })
    const fallback = (await navigatorOnline()) ? 'true Con conexión' : 'false Sin conexión'
    await eventually(state, (value) => value === fallback, `the navigator fallback (${fallback})`)

    await setLanguage('en')
    await e2e('connectivity', { connectivity: 'offline' })
    await eventually(state, (value) => value === 'false Offline', 'the English offline label')
    await e2e('connectivity', { connectivity: 'online' })
    await eventually(state, (value) => value === 'true Online', 'the English online label')
    await e2e('connectivity', { connectivity: 'real' })
  })

  it('hiding every capsule integration removes the middle zone', async () => {
    await launchClaude({ files: { 'settings.json': seededSettings(DEFAULT_ALERTS) } })
    const bridge = await installClaudeHooks()
    expect((await postHook(bridge.hook, hookEvent('api-server', 'UserPromptSubmit'))).status).toBe(200)
    await pointer(true)
    await expectMode('compact')
    await $(present('capsule-zone-blocks')).waitForDisplayed()
    await expectCompactFits(['capsule-zone-left', 'capsule-zone-blocks', 'claude-dots', 'capsule-zone-system'])

    await openControlCenter()
    await $('//nav//button[normalize-space()="Integraciones" or normalize-space()="Integrations"]').click()
    await $('[data-testid="integrations-table"]').waitForDisplayed()
    const readIntegrations = () =>
      (JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8')) as { integrations: Record<string, { capsule: boolean }> }).integrations
    for (const key of ['claude', 'gmail', 'github', 'gitlab', 'redmine']) {
      // The row's second switch is «Cápsula».
      await (await $$(`[data-testid="integration-row-${key}"] [role="switch"]`))[1]!.click()
      await eventually(async () => readIntegrations()[key]?.capsule, (capsuleOn) => capsuleOn === false, `${key} out of the capsule`)
    }

    await useWindow('notch')
    await pointer(true)
    await expectMode('compact')
    await eventually(() => count(present('capsule-zone-blocks')), (n) => n === 0, 'the middle zone gone')
    await expectCompactFits(['capsule-zone-left', 'capsule-zone-system'])
    expect(await count(present('claude-dots'))).toBe(0)
    expect(await count('[data-testid="capsule-divider"]:not([aria-hidden="true"] *)')).toBe(1)

    await setLanguage('en')
    await settle()
    expect(await count(present('capsule-zone-blocks'))).toBe(0)
    await expectCompactFits(['capsule-zone-left', 'capsule-zone-system'])
  })
})
