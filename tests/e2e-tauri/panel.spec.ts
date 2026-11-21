/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The main panel (0.3.0): the card row with its wheel, keys, page indicator and edge mask, the Claude
// card and quick access with something pending, and every card's text inside its 172×196 box.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { $, $$, browser, expect } from '@wdio/globals'
import { DEFAULT_INTEGRATION_COLORS, INTEGRATION_COLOR_HEX, type IntegrationKey } from '../../src/shared/integrations/colors'
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
  alignZoneWithWindows,
  claudeSettingsFile,
  cssOf,
  DEFAULT_ALERTS,
  dataDir,
  e2e,
  eventually,
  fillValue,
  hookEvent,
  inPage,
  installClaudeHooks,
  ipc,
  labelledField,
  launch,
  launchClaude,
  openControlCenter,
  openedUrls,
  pageLang,
  postHook,
  quitApp,
  readLogs,
  rectOf,
  requestIntent,
  seededSettings,
  setLanguage,
  settle,
  useWindow,
} from './helpers'

const ROW = '[data-testid="card-row"]'
const PAGES = '[data-testid="card-row-pages"]'
const HEADER_SYSTEM = '[data-testid="panel-system"]'
const capsule = () => $('[data-testid="notch-capsule"]')
const expectMode = (mode: string) => expect(capsule()).toHaveAttribute('data-mode', mode)

const seeded = { 'settings.json': seededSettings(DEFAULT_ALERTS) }

const panelDismissesLogged = (): number => (readLogs().match(/notch: mode change from expanded to \w+ on Dismiss/g) ?? []).length

/**
 * Opens the panel and checks it stays open. With the Control Center left open the panel can lose the
 * OS focus right after expanding (the known follow-up of code-review.spec.ts `expandPanel`): only that
 * case, seen as a new Dismiss line in the log, is retried.
 */
async function openPanel(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const before = panelDismissesLogged()
    await requestIntent('expand')
    await expectMode('expanded')
    await browser.pause(300)
    if ((await capsule().getAttribute('data-mode')) === 'expanded') break
    if (attempt === 3 || panelDismissesLogged() === before) throw new Error('The panel did not stay open')
    console.log(`The panel lost the focus right after opening (attempt ${attempt}); opening it again (known follow-up)`)
  }
  await $(ROW).waitForDisplayed()
  await settle()
}

const scrollLeft = (): Promise<number> =>
  inPage(
    (selector: string) =>
      (globalThis as unknown as { document: { querySelector(s: string): { scrollLeft: number } | null } }).document.querySelector(selector)?.scrollLeft ?? -1,
    ROW,
  )

/** The indicator as the eye reads it: how many marks there are and which one is the 16 px bar. */
const indicator = (): Promise<{ marks: number; active: number }> =>
  inPage((selector: string) => {
    type Mark = { getBoundingClientRect(): { width: number } }
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Mark> } }).document
    const widths = Array.from(doc.querySelectorAll(`${selector} > span`)).map((mark) => mark.getBoundingClientRect().width)
    return { marks: widths.length, active: widths.findIndex((width) => width === 16) }
  }, PAGES)

const expectPage = (page: number, left: number) =>
  eventually(
    async () => ({ left: await scrollLeft(), ...(await indicator()) }),
    (now) => Math.abs(now.left - left) < 1 && now.active === page,
    `page ${page} at ${left} px`,
  )

/** A real wheel notch over the middle of the row. */
async function wheel(deltaY: number): Promise<void> {
  const row = (await rectOf(ROW))!
  await browser
    .action('wheel')
    .scroll({ x: Math.round(row.x + row.width / 2), y: Math.round(row.y + row.height / 2), deltaX: 0, deltaY, duration: 0 })
    .perform()
}

/** The index of the card that holds the focus, or null when the focus is elsewhere. */
const focusedCard = (): Promise<number | null> =>
  inPage(() => {
    type El = { closest(s: string): { getAttribute(n: string): string | null } | null; hasAttribute(n: string): boolean }
    const active = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement
    if (!active?.hasAttribute('data-card-main')) return null
    return Number(active.closest('[data-card-index]')?.getAttribute('data-card-index'))
  })

const expectFocusOn = (index: number) => eventually(focusedCard, (card) => card === index, `the focus on card ${index}`)

/** The card lies whole inside the row, clear of the mask that fades its right edge until the row ends. */
async function expectCardInView(index: number): Promise<void> {
  await eventually(
    async () => {
      const row = (await rectOf(ROW))!
      const card = (await rectOf(`[data-card-index="${index}"]`))!
      const { marks, active } = await indicator()
      const faded = active === marks - 1 ? 0 : 48
      return card.x >= row.x - 0.5 && card.x + card.width <= row.x + row.width - faded + 0.5
    },
    (inView) => inView,
    `card ${index} whole in view`,
  )
}

const readIntegrations = (): Record<string, { enabled: boolean }> =>
  (JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8')) as { integrations: Record<string, { enabled: boolean }> }).integrations

/** Turns an integration off in the open «Integraciones» page and waits for settings.json to say so. */
async function turnOff(key: string): Promise<void> {
  const switches = await $$(`[data-testid="integration-row-${key}"] [role="switch"]`)
  await switches[0]!.click()
  await eventually(async () => readIntegrations()[key]?.enabled, (enabled) => enabled === false, `${key} saved as off`)
}

interface Overflow {
  card: string | null
  text: string
}

/**
 * Every card measures 172×196 and every text stays inside it. Text cut with an ellipsis is measured by
 * its element's box (what shows); any other text by its own glyphs, so clipped text counts as overflow.
 */
const cardOverflows = (): Promise<{ cards: number; sizes: string[]; overflows: Overflow[] }> =>
  inPage(() => {
    type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
    type El = { getBoundingClientRect(): Box; getAttribute(name: string): string | null }
    type Text = { textContent: string | null; parentElement: El }
    const w = globalThis as unknown as {
      document: {
        querySelectorAll(selector: string): ArrayLike<El>
        createTreeWalker(root: El, show: number): { nextNode(): Text | null }
        createRange(): { selectNodeContents(node: Text): void; getBoundingClientRect(): Box }
      }
      getComputedStyle(el: El): { textOverflow: string }
    }
    const SHOW_TEXT = 4
    const cards = Array.from(w.document.querySelectorAll('[data-card-index] > div'))
    const sizes: string[] = []
    const overflows: { card: string | null; text: string }[] = []
    for (const card of cards) {
      const box = card.getBoundingClientRect()
      sizes.push(`${Math.round(box.width)}x${Math.round(box.height)}`)
      const walker = w.document.createTreeWalker(card, SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? ''
        if (text === '') continue
        const range = w.document.createRange()
        range.selectNodeContents(node)
        const ellipsized = w.getComputedStyle(node.parentElement).textOverflow === 'ellipsis'
        const painted = ellipsized ? node.parentElement.getBoundingClientRect() : range.getBoundingClientRect()
        const inside = painted.left >= box.left - 0.5 && painted.right <= box.right + 0.5 && painted.top >= box.top - 0.5 && painted.bottom <= box.bottom + 0.5
        if (!inside) overflows.push({ card: card.getAttribute('data-testid'), text })
      }
    }
    return { cards: cards.length, sizes, overflows }
  })

interface Fakes {
  codeReview: FakeCodeReview
  gmail: FakeGmail
  redmine: FakeRedmine
}

/** The fake servers of the running test, closed even when it fails. */
let fakes: Fakes | undefined

/** Nothing connected yet and every alert of the four integrations off: only the cards are under test. */
const unconnectedSettings = () => ({
  ...seededSettings(DEFAULT_ALERTS),
  gmail: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, alerts: { enabled: false, hideContent: false, sound: false } },
  codeReview: { gitlabUrl: '', alerts: { github: { enabled: false, sound: false }, gitlab: { enabled: false, sound: false } } },
  redmine: { url: '', dailyTargetHours: 8, endOfDay: { enabled: false, time: '18:00', sound: false } },
})

const SAVE = './/button[normalize-space()="Comprobar y guardar"]'

/** GitHub and GitLab from the Control Center, as code-review.spec.ts connects them. */
async function connectCodeReview(): Promise<void> {
  await useWindow('notch')
  await openControlCenter('code-review')
  await $('[data-testid="code-review-page"]').waitForDisplayed()
  const github = '[data-testid="code-review-github"]'
  await fillValue(await labelledField(github, 'Token de GitHub'), FAKE_GITHUB_TOKEN)
  await $(github).$(SAVE).click()
  await expect($('[data-testid="code-review-github-status"] span')).toHaveText(`Conectado como ${FAKE_GITHUB_LOGIN}`)
  const gitlab = '[data-testid="code-review-gitlab"]'
  await fillValue(await labelledField(gitlab, 'URL de GitLab'), FAKE_GITLAB_ORIGIN)
  await fillValue(await labelledField(gitlab, 'Token de GitLab'), FAKE_GITLAB_TOKEN)
  await $(gitlab).$(SAVE).click()
  await expect($('[data-testid="code-review-gitlab-status"] span')).toHaveText(`Conectado como ${FAKE_GITLAB_USER.username}`)
}

/** Redmine from the Control Center, as redmine.spec.ts connects it. */
async function connectRedmine(): Promise<void> {
  await useWindow('notch')
  await openControlCenter('redmine')
  await $('[data-testid="redmine-page"]').waitForDisplayed()
  const connection = '[data-testid="redmine-connection"]'
  await fillValue(await labelledField(connection, 'URL de Redmine'), FAKE_REDMINE_ORIGIN)
  await fillValue(await labelledField(connection, 'Clave de acceso API'), FAKE_REDMINE_KEY)
  await $(connection).$(SAVE).click()
  await expect($('[data-testid="redmine-status"] span')).toHaveText(`Conectado como ${FAKE_REDMINE_ACCOUNT}`)
}

/** Gmail's sign-in, playing the browser as gmail.spec.ts does: the consent URL, then the loopback redirect. */
async function connectGmail(server: FakeGmail): Promise<void> {
  await useWindow('notch')
  await openControlCenter('gmail')
  await $('[data-testid="gmail-page"]').waitForDisplayed()
  const session = $('[data-testid="gmail-session"]')
  await session.$('.//button[normalize-space()="Iniciar sesión"]').click()
  const consent = await eventually(
    async () => (await openedUrls()).find((url) => url.startsWith(`${server.base}/o/oauth2/v2/auth?`)) ?? '',
    (url) => url !== '',
    'the consent URL',
  )
  const consented = await fetch(consent, { redirect: 'manual' })
  expect((await fetch(new URL(consented.headers.get('location') ?? ''))).status).toBe(200)
  await eventually(() => session.getAttribute('data-status'), (status) => status === 'ok', 'the Gmail session')
  await expect(session).toHaveText(expect.stringContaining(FAKE_ACCOUNT))
}

/** The four integrations show their data, not a notice. */
async function expectCardsWithData(): Promise<void> {
  for (const card of ['integration-github', 'integration-gitlab']) {
    await $(`[data-testid="${card}"] .digits`).waitForExist({ timeout: 15_000 })
  }
  // Redmine: both figures, and the month's squares from the summary (today's has hours, not the grey grid).
  for (const figure of ['redmine-card-today', 'redmine-card-month']) {
    await $(`[data-testid="integration-redmine"] [data-testid="${figure}"] .digits`).waitForExist({ timeout: 15_000 })
  }
  await $('[data-testid="integration-redmine"] [data-today="true"]:not([data-level="0"])').waitForExist({ timeout: 15_000 })
  await eventually(async () => (await $$('[data-testid="integration-gmail"] li')).length, (mails) => mails === 3, 'three mails on the Gmail card', 15_000)
}

describe('Main panel (Tauri)', () => {
  afterEach(async () => {
    const running = fakes
    fakes = undefined
    if (running) await Promise.all(Object.values(running).map((fake) => fake.close().catch(() => undefined)))
  })

  after(async () => {
    await quitApp()
  })

  it('wheel scrolls the card row and the indicator follows', async () => {
    await launch({ fresh: true, files: seeded })
    await openPanel()
    expect(await cssOf(ROW, 'mask-image')).toContain('linear-gradient')
    // Seven cards, three whole in view: five places for the row to stop.
    await expectPage(0, 0)
    expect((await indicator()).marks).toBe(5)

    await wheel(200)
    await expectPage(1, 182)
    // Past the wheel's idle time, so this notch starts from the page the row stands on.
    await browser.pause(300)
    await wheel(2000)
    await expectPage(4, 632)
    // The row ends on its last card: no empty space after it, and the fade moves to the half card on the left.
    const row = (await rectOf(ROW))!
    const last = (await rectOf('[data-card-index="6"]'))!
    expect(Math.round(last.x + last.width)).toBe(Math.round(row.x + row.width))
    expect(await cssOf(ROW, 'mask-image')).toContain('to left')
    await browser.pause(300)
    await wheel(-2000)
    await expectPage(0, 0)
  })

  it('arrow keys move focus between cards and Enter opens', async () => {
    await launch({ fresh: true, files: seeded })
    await openPanel()

    // With nothing focused the first arrow lands on the first card, and the left end stops there.
    await browser.keys('ArrowRight')
    await expectFocusOn(0)
    await browser.keys('ArrowLeft')
    await expectFocusOn(0)

    for (const index of [1, 2, 3, 4, 5, 6]) {
      await browser.keys('ArrowRight')
      await expectFocusOn(index)
      await expectCardInView(index)
    }
    // The right end stops there too: no wrapping round.
    await browser.keys('ArrowRight')
    await browser.pause(200)
    await expectFocusOn(6)
    await expectPage(4, 632)

    await browser.keys('Enter')
    await expectMode('notes')
    await browser.keys('Escape')
    await expectMode('expanded')
  })

  it('three cards or fewer show no indicator', async () => {
    await launch({ fresh: true, files: seeded })
    await openControlCenter()
    await $('//nav//button[normalize-space()="Integraciones" or normalize-space()="Integrations"]').click()
    await $('[data-testid="integrations-table"]').waitForDisplayed()
    for (const key of ['gitlab', 'gmail', 'redmine']) await turnOff(key)

    // Four cards still overflow: two places to stop.
    await useWindow('notch')
    await openPanel()
    await eventually(indicator, (now) => now.marks === 2 && now.active === 0, 'two pages')
    expect(await cssOf(ROW, 'mask-image')).toContain('linear-gradient')

    await useWindow('control-center')
    await turnOff('notes')

    await useWindow('notch')
    await openPanel()
    await eventually(async () => (await $$('[data-card-index]')).length, (count) => count === 3, 'three cards')
    await expect($(PAGES)).not.toExist()
    expect(await cssOf(ROW, 'mask-image')).toBe('none')
    // Nothing is left to scroll: the wheel leaves the row where it is.
    await wheel(400)
    await browser.pause(300)
    expect(await scrollLeft()).toBe(0)
  })

  it('the header shows the system metrics as plain figures and fits in both languages', async () => {
    await launch({ fresh: true, files: seeded })
    await openPanel()
    await expect($('[data-testid="integration-system"]')).not.toExist()
    const header = $(HEADER_SYSTEM)
    await header.waitForDisplayed({ timeout: 10_000 })
    for (const metric of ['metric-cpu', 'metric-ram', 'metric-connection']) {
      await expect(header.$(`[data-testid="${metric}"]`)).toBeDisplayed()
    }
    // The metrics wear the same background as the header's icon buttons, 4 px from them.
    const iconButton = '[data-notch-panel] header button:not([data-testid])'
    expect(await cssOf(HEADER_SYSTEM, 'background-color')).toBe(await cssOf(iconButton, 'background-color'))
    const pill = (await rectOf(HEADER_SYSTEM))!
    expect(Math.round((await rectOf(iconButton))!.x - (pill.x + pill.width))).toBe(4)

    for (const language of ['es', 'en'] as const) {
      await setLanguage(language)
      await eventually(pageLang, (lang) => lang === language, `the panel in ${language}`)
      await settle()
      const clock = (await rectOf('[data-notch-panel] header > span:first-child'))!
      const metrics = (await rectOf(HEADER_SYSTEM))!
      const settingsButton = (await rectOf('[data-notch-panel] header button:not([data-testid])'))!
      expect({ language, clear: metrics.x >= clock.x + clock.width }).toEqual({ language, clear: true })
      expect({ language, clear: metrics.x + metrics.width <= settingsButton.x }).toEqual({ language, clear: true })
    }

    // There is no System view: the metrics are not a button and a click keeps the panel.
    expect(await header.getTagName()).toBe('span')
    expect(await header.getAttribute('title')).toBeNull()
    await header.click()
    await browser.pause(300)
    await expectMode('expanded')
  })

  it('claude card opens the pending permission', async () => {
    claudeSettingsFile()
    await launchClaude()
    const bridge = await installClaudeHooks()
    await postHook(bridge.hook, hookEvent('api-server', 'UserPromptSubmit'))
    await openPanel()
    await expect($('[data-testid="quick-claude-pending"]')).not.toExist()

    // A permission never opens or closes the panel: it waits behind the coral dot.
    const reply = postHook(bridge.hook, hookEvent('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }))
    const dot = $('[data-testid="quick-claude-pending"]')
    await dot.waitForDisplayed()
    await expectMode('expanded')
    // Rounded: the panel's transform leaves float noise in the box.
    const dotBox = (await rectOf('[data-testid="quick-claude-pending"]'))!
    expect({ width: Math.round(dotBox.width), height: Math.round(dotBox.height) }).toEqual({ width: 10, height: 10 })
    await expect(dot).toHaveElementClass('bg-wait')

    await $('[data-testid="claude-sessions"] [data-card-main]').click()
    await expectMode('permission')
    await expect($('[data-testid="claude-permission"]')).toHaveText(expect.stringContaining('npm run build'))

    // Answered, so the held hook does not outlive the test.
    await $('[data-testid="claude-deny"]').waitForEnabled({ timeout: 3000 })
    await $('[data-testid="claude-deny"]').click()
    expect((await reply).status).toBe(200)
  })

  it('every card paints its own integration color', async () => {
    await launch({ fresh: true, files: seeded })
    await openPanel()
    const painted = await inPage(() => {
      type El = { querySelector(s: string): El | null; getAttribute(n: string): string | null; appendChild(el: El): void; remove(): void; className: string }
      const w = globalThis as unknown as {
        document: { querySelectorAll(s: string): ArrayLike<El>; createElement(tag: string): El }
        getComputedStyle(el: El): { color: string; backgroundColor: string }
      }
      return Array.from(w.document.querySelectorAll('[data-card-index] > div')).map((card) => {
        // The top level of the contributions chart, measured on a square inside the card.
        const square = w.document.createElement('span')
        square.className = 'bg-contrib-4'
        card.appendChild(square)
        const level = w.getComputedStyle(square).backgroundColor
        square.remove()
        return { card: card.getAttribute('data-testid'), icon: w.getComputedStyle(card.querySelector('svg')!).color, level }
      })
    })
    const channels = (color: string): number[] => {
      const values = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      return color.startsWith('color(') ? values.map((value) => Math.round(value * 255)) : values
    }
    const hex = (color: string): number[] => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16))
    const owner = (card: string | null) => (card === 'claude-sessions' ? 'claude' : (card ?? '').replace('integration-', '')) as IntegrationKey
    for (const { card, icon, level } of painted) {
      const expected = hex(INTEGRATION_COLOR_HEX[DEFAULT_INTEGRATION_COLORS[owner(card)]])
      expect({ card, icon: channels(icon), level: channels(level) }).toEqual({ card, icon: expected, level: expected })
    }
  })

  it('nothing overflows its card', async () => {
    claudeSettingsFile()
    // The fake checks the contributions ranges against the app's days (see code-review.spec.ts).
    alignZoneWithWindows()
    fakes = { codeReview: await startFakeCodeReview(), gmail: await startFakeGmail(), redmine: await startFakeRedmine() }
    const { codeReview, gmail, redmine } = fakes
    for (const { base } of [codeReview, gmail, redmine]) {
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) throw new Error(`Unexpected fake origin ${base}`)
    }
    const inOneMinute = new Date(Date.now() + 60_000).toISOString()
    const inTwoHours = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const reminder = (text: string, dueAt: string) => ({
      id: randomUUID(),
      text,
      dueAt,
      repeat: 'none',
      state: 'pending',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    })
    await launchClaude({
      env: {
        NOTCH_CODE_REVIEW_BASE_URLS: `github=${codeReview.base},gitlab=${codeReview.base}`,
        NOTCH_GMAIL_BASE_URL: gmail.base,
        NOTCH_REDMINE_BASE_URL: redmine.base,
        NOTCH_OPEN_URL_LOG: '1',
      },
      files: {
        'settings.json': unconnectedSettings(),
        'reminders.json': {
          version: 1,
          reminders: [
            reminder('Llamar al proveedor', inOneMinute),
            reminder('Revisar la propuesta de presupuesto del proyecto de migración antes de la reunión con dirección', inTwoHours),
          ],
        },
      },
    })
    const bridge = await installClaudeHooks()
    for (const session of ['plataforma-de-facturacion-electronica-internacional', 'servicio-de-notificaciones-en-tiempo-real', 'web-client']) {
      await postHook(bridge.hook, hookEvent(session, 'UserPromptSubmit'))
    }
    for (const text of ['Una nota muy larga que no cabe de ninguna manera en una sola línea de la tarjeta', 'Lista de la compra', 'Ideas']) {
      expect((await ipc('notes:create', { text })).ok).toBe(true)
    }
    // The recorder must be on before the sign-in: never a real browser.
    expect(await openedUrls()).toEqual([])
    await connectCodeReview()
    await connectRedmine()
    await connectGmail(gmail)
    await useWindow('notch')
    await openPanel()
    await expectCardsWithData()
    // The first reminder falls due with the panel open: the badge and the coral line show too.
    await e2e('advance-clock', { ms: 90_000 })
    await $('[data-testid="integration-reminders-badge"]').waitForDisplayed()
    await $('[data-testid="claude-sessions-more"]').waitForExist()

    for (const language of ['es', 'en'] as const) {
      await setLanguage(language)
      await eventually(pageLang, (lang) => lang === language, `the panel in ${language}`)
      await expectCardsWithData()
      await settle()
      const measured = await cardOverflows()
      expect({ language, cards: measured.cards }).toEqual({ language, cards: 7 })
      expect({ language, sizes: [...new Set(measured.sizes)] }).toEqual({ language, sizes: ['172x196'] })
      expect({ language, overflows: measured.overflows }).toEqual({ language, overflows: [] })
    }
    expect([...codeReview.violations, ...gmail.violations, ...redmine.violations]).toEqual([])
  })
})
