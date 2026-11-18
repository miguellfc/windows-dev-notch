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
  claudeSettingsFile,
  cssOf,
  DEFAULT_ALERTS,
  dataDir,
  e2e,
  eventually,
  hookEvent,
  inPage,
  installClaudeHooks,
  ipc,
  launch,
  launchClaude,
  openControlCenter,
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

/** The card lies whole inside the row, clear of the mask that fades the row's last 48 px. */
async function expectCardInView(index: number): Promise<void> {
  await eventually(
    async () => {
      const row = (await rectOf(ROW))!
      const card = (await rectOf(`[data-card-index="${index}"]`))!
      return card.x >= row.x - 0.5 && card.x + card.width <= row.x + row.width - 48 + 0.5
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

describe('Main panel (Tauri)', () => {
  after(async () => {
    await quitApp()
  })

  it('wheel scrolls the card row and the indicator follows', async () => {
    await launch({ fresh: true, files: seeded })
    await openPanel()
    expect(await cssOf(ROW, 'mask-image')).toContain('linear-gradient')
    // Eight cards, three whole in view: six places for the row to stop.
    await expectPage(0, 0)
    expect((await indicator()).marks).toBe(6)

    await wheel(200)
    await expectPage(1, 182)
    // Past the wheel's idle time, so this notch starts from the page the row stands on.
    await browser.pause(300)
    await wheel(2000)
    await expectPage(5, 910)
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

    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      await browser.keys('ArrowRight')
      await expectFocusOn(index)
      await expectCardInView(index)
    }
    // The right end stops there too: no wrapping round.
    await browser.keys('ArrowRight')
    await browser.pause(200)
    await expectFocusOn(7)
    await expectPage(5, 910)

    await browser.keys('Enter')
    await expectMode('system')
    await browser.keys('Escape')
    await expectMode('expanded')
  })

  it('three cards or fewer show no indicator', async () => {
    await launch({ fresh: true, files: seeded })
    await openControlCenter()
    await $('//nav//button[normalize-space()="Integraciones" or normalize-space()="Integrations"]').click()
    await $('[data-testid="integrations-table"]').waitForDisplayed()
    for (const key of ['gitlab', 'gmail', 'redmine', 'reminders']) await turnOff(key)

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
      files: {
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
    await openPanel()
    // The first reminder falls due with the panel open: the badge and the coral line show too.
    await e2e('advance-clock', { ms: 90_000 })
    await $('[data-testid="integration-reminders-badge"]').waitForDisplayed()
    await $('[data-testid="claude-sessions-more"]').waitForExist()

    for (const language of ['es', 'en'] as const) {
      await setLanguage(language)
      await eventually(pageLang, (lang) => lang === language, `the panel in ${language}`)
      await settle()
      const measured = await cardOverflows()
      expect({ language, cards: measured.cards }).toEqual({ language, cards: 8 })
      expect({ language, sizes: [...new Set(measured.sizes)] }).toEqual({ language, sizes: ['172x196'] })
      expect({ language, overflows: measured.overflows }).toEqual({ language, overflows: [] })
    }
  })
})
