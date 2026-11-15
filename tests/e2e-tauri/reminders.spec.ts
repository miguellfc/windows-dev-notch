/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Reminders, ported from tests/e2e/reminders.spec.ts (Electron). The test clock is
// `__e2e:advance-clock` (Electron's `__notchTestClock.advance`): it moves the wall clock and the
// timers and answers once the reminders check it forces has finished.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  capsuleWindow,
  dataDir,
  DEFAULT_ALERTS,
  e2e,
  eventually,
  fillValue,
  inPage,
  launch,
  openControlCenter,
  pointer,
  pointerToCorner,
  quitApp,
  rectOf,
  requestIntent,
  seededSettings,
  settle,
} from './helpers'

const DAY_MS = 24 * 60 * 60_000
const SETTINGS = seededSettings(DEFAULT_ALERTS)

interface Seed {
  text: string
  dueAt: Date
}

const remindersFile = (reminders: Seed[]) => ({
  version: 1,
  reminders: reminders.map(({ text, dueAt }) => ({
    id: randomUUID(),
    text,
    dueAt: dueAt.toISOString(),
    repeat: 'none',
    state: 'pending',
    createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
  })),
})

const start = (reminders?: Seed[]) =>
  launch({
    fresh: true,
    files: reminders ? { 'settings.json': SETTINGS, 'reminders.json': remindersFile(reminders) } : { 'settings.json': SETTINGS },
  })

const pad = (n: number): string => String(n).padStart(2, '0')
const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const isoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const capsule = () => $('[data-testid="notch-capsule"]')
const expectMode = (value: string, wait?: number) =>
  expect(capsule()).toHaveAttribute('data-mode', value, wait === undefined ? undefined : { wait })
const advance = (ms: number) => e2e('advance-clock', { ms })

const ITEM = '[data-testid="reminder-item"]'
const itemCount = async () => (await $$(ITEM)).length
const expectItems = (n: number) => eventually(itemCount, (count) => count === n, `${n} reminders`)
/** Rows holding `text` (Playwright's `filter({ hasText })`). */
const itemsWith = (text: string) => $$(`//*[@data-testid="reminder-item"][contains(., ${JSON.stringify(text)})]`)
const SNOOZE = '//button[contains(normalize-space(), "Posponer")]'
/** Rows with a Snooze button: the due ones. */
const DUE = `//*[@data-testid="reminder-item"][.${SNOOZE}]`
const dueCount = async () => (await $$(DUE)).length
/** The attention row's "Completar" (the upcoming rows' Complete is an icon named "Completar <text>"). */
const COMPLETE = '//button[normalize-space()="Completar" and not(@aria-label)]'
const radio = (name: string) => $(`//*[@data-testid="reminder-form"]//*[@role="radio" and normalize-space()=${JSON.stringify(name)}]`)

const focusedTestId = (): Promise<string | null> =>
  inPage(
    () =>
      (
        globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }
      ).document.activeElement?.getAttribute('data-testid') ?? null,
  )
const expectFocused = (testId: string) => eventually(focusedTestId, (id) => id === testId, `${testId} focused`)

describe('Reminders (Tauri)', () => {
  after(async () => {
    await quitApp()
  })

  it('creates two reminders, raises the alert when due, then snoozes and completes them', async () => {
    await start()

    await requestIntent('expand')
    await expectMode('expanded')
    const tile = () => $('[data-testid="integration-reminders"]')
    await expect(tile()).toBeDisplayed()
    await settle()
    // Every tile label keeps at least 4 px from the tile's edges ("Recordatorios" is the longest).
    for (const id of ['terminal', 'reminders']) {
      // The label shrinks to its text (truncating only when it would overflow), so its box is the text's.
      const tileBox = (await rectOf(`[data-testid="integration-${id}"]`))!
      const textBox = (await rectOf(`[data-testid="integration-${id}"] span`))!
      const clearance = Math.min(textBox.x - tileBox.x, tileBox.x + tileBox.width - (textBox.x + textBox.width))
      expect({ id, ok: clearance >= 4 }).toEqual({ id, ok: true })
    }

    await tile().click()
    await expectMode('reminders')
    await expect($('[data-testid="reminders-empty"]')).toBeDisplayed()
    const add = () => $('[data-testid="reminders-add"]')
    await expectFocused('reminders-add')
    await settle()

    const form = () => $('[data-testid="reminder-form"]')
    const TEXT = '[data-testid="reminder-form-text"]'
    const TIME = '[data-testid="reminder-form-time"]'

    // A one-off reminder 30 minutes from now (Mañana if that crosses midnight), saved with Enter.
    await add().click()
    await expectFocused('reminder-form-text')
    await expect($(TIME)).toHaveValue(expect.stringMatching(/^([01]\d|2[0-3]):(00|15|30|45)$/))
    const inThirty = new Date(Date.now() + 30 * 60_000)
    if (inThirty.getDate() !== new Date().getDate()) await radio('Mañana').click()
    await fillValue(TEXT, 'revisar PR')
    await fillValue(TIME, hhmm(inThirty))
    await settle()
    await browser.keys('Enter')
    await form().waitForDisplayed({ reverse: true })
    await expectItems(1)

    // Validation stays inline: no text, then a bad time.
    await add().click()
    await $('[data-testid="reminder-form-save"]').click()
    await expect($('[data-testid="reminder-form-text-error"]')).toHaveText('Escribe qué recordar')
    // Worst case for the panel height: Other day (date row) plus an inline error.
    await radio('Otro día').click()
    const date = () => $('[data-testid="reminder-form-date"]')
    await expect(date()).toBeDisplayed()
    // "Other day" starts on tomorrow; today stays selectable.
    const now = new Date()
    await expect(date()).toHaveValue(isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)))
    await expect(date()).toHaveAttribute('min', isoDate(now))
    await settle()
    await radio('Hoy').click()
    await fillValue(TEXT, 'desplegar build')
    await fillValue(TIME, '25:00')
    await $('[data-testid="reminder-form-save"]').click()
    await expect($('[data-testid="reminder-form-time-error"]')).toHaveText('Hora no válida (HH:mm)')

    // A daily reminder 20 minutes from now: the Day field hides, the first occurrence is the next one.
    await radio('Cada día').click()
    await $('//*[@role="radiogroup" and @aria-label="Día"]').waitForDisplayed({ reverse: true })
    await fillValue(TIME, hhmm(new Date(Date.now() + 20 * 60_000)))
    await $('[data-testid="reminder-form-save"]').click()
    await form().waitForDisplayed({ reverse: true })
    await expectItems(2)
    expect((await itemsWith('revisar PR')).length).toBe(1)
    expect((await itemsWith('desplegar build')).length).toBe(1)
    await expect(
      $('//*[@data-testid="reminder-item"][contains(., "desplegar build")]//*[@role="img" and @aria-label="Se repite cada día"]'),
    ).toBeDisplayed()

    // Esc in the form returns to the list, not to the integrations row.
    await add().click()
    await expectFocused('reminder-form-text')
    await browser.keys('Escape')
    await form().waitForDisplayed({ reverse: true })
    await expectMode('reminders')
    await expectFocused('reminders-add')

    // A click on a blank (non-focusable) part of the form keeps Esc in the form: back to the list.
    await add().click()
    // Bottom-left corner: blank, and low enough that the pointer is off the compact capsule later.
    // (WebDriver click offsets are from the element's centre.)
    const formBox = (await rectOf('[data-testid="reminder-form"]'))!
    await form().click({ x: Math.round(4 - formBox.width / 2), y: Math.round(formBox.height / 2 - 4) })
    await browser.keys('Escape')
    await form().waitForDisplayed({ reverse: true })
    await expectMode('reminders')
    await settle()

    // Back to the resting capsule so the alert can take it over. WebDriver's clicks moved its
    // virtual pointer over the page, and in the `e2e` build those pointer events reach the
    // controller as hover (in the real app only the cursor poller reports it): the pointer leaves
    // first, as it does in Electron where the click above lands outside the compact capsule.
    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')

    await advance(31 * 60_000)
    await expectMode('alert', 1000)
    const alert = () => $('[data-testid="reminder-alert"]')
    await alert().waitForDisplayed({ timeout: 1000 })
    await expect(alert()).toHaveText(expect.stringContaining('2 recordatorios'))
    await settle()

    await requestIntent('expand')
    await expectMode('reminders')
    await eventually(dueCount, (n) => n === 2, 'two due reminders')
    await settle()

    // Snooze the first from the keyboard: it leaves the due list and focus moves to the next row's
    // action instead of <body>, so Esc goes back to the integrations row and never dismisses.
    const snoozedId = await $(`(${DUE})[1]`).getAttribute('data-reminder-id')
    await inPage((xpath: string) => {
      const doc = (
        globalThis as unknown as {
          document: { evaluate(x: string, n: unknown, r: null, t: number, s: null): { singleNodeValue: { focus(): void } | null } }
        }
      ).document
      doc.evaluate(xpath, doc, null, 9, null).singleNodeValue?.focus()
    }, `(${DUE}${SNOOZE})[1]`)
    await browser.keys('Enter')
    await eventually(dueCount, (n) => n === 1, 'one due reminder left')
    const snoozeFocused = () =>
      inPage((xpath: string) => {
        const doc = (
          globalThis as unknown as {
            document: { activeElement: unknown; evaluate(x: string, n: unknown, r: null, t: number, s: null): { singleNodeValue: unknown } }
          }
        ).document
        return doc.evaluate(xpath, doc, null, 9, null).singleNodeValue === doc.activeElement
      }, `(${DUE}${SNOOZE})[1]`)
    await eventually(snoozeFocused, (yes) => yes, "the next row's Snooze focused")
    // The snoozed reminder is back in the pending list (no longer due), not dropped.
    await expectItems(2)
    const snoozed = `${ITEM}[data-reminder-id="${snoozedId}"]`
    await expect($(snoozed)).toHaveAttribute('data-state', 'pending')
    expect((await $$(`//*[@data-reminder-id="${snoozedId}"]${SNOOZE}`)).length).toBe(0)
    await browser.keys('Escape')
    await expectMode('expanded')
    await expect($('[data-testid="integration-reminders-badge"]')).toHaveText('1')
    await expect(tile()).toHaveAttribute('aria-label', 'Recordatorios, 1 recordatorio vencido')
    await settle()

    // A click on a blank part of the list panel keeps Esc in the panel too.
    await tile().click()
    await expectMode('reminders')
    await $('//h2[normalize-space()="Recordatorios"]').click()
    await browser.keys('Escape')
    await expectMode('expanded')
    await tile().click()
    await expectMode('reminders')
    // Complete the remaining one: nothing is due any more.
    await $(COMPLETE).click()
    await eventually(async () => (await $$(SNOOZE)).length, (n) => n === 0, 'no Snooze button left')

    await pointer(false)
    await requestIntent('dismiss')
    await expectMode('peek')
    await $('[data-testid="reminder-alert"]').waitForDisplayed({ reverse: true })
  })

  it('a due reminder alerts over a capsule hidden by the user ("Ocultar"); closing its panel hides it again', async () => {
    await start([{ text: 'regar las plantas', dueAt: new Date(Date.now() + 30 * 60_000) }])
    await expectMode('peek')

    await requestIntent('expand')
    await $('button[aria-label="Ocultar"]').click()
    await capsule().waitForExist({ reverse: true })
    await eventually(capsuleWindow, (w) => !w.visible, 'the notch window hidden')

    await advance(31 * 60_000)
    await expectMode('alert')
    await expect($('[data-testid="reminder-alert"]')).toHaveText(expect.stringContaining('regar las plantas'))
    expect((await capsuleWindow()).visible).toBe(true)

    // The panel opens from the alert; completing the reminder and closing goes back to hidden.
    await requestIntent('expand')
    await expectMode('reminders')
    await $(COMPLETE).click()
    await eventually(async () => (await $$(SNOOZE)).length, (n) => n === 0, 'no Snooze button left')
    await requestIntent('dismiss')
    await capsule().waitForExist({ reverse: true })
    await eventually(capsuleWindow, (w) => !w.visible, 'the notch window hidden again')
  })

  it('a reminder that came due while the app was closed raises the missed alert at startup', async () => {
    await start([{ text: 'llamar al banco', dueAt: new Date(Date.now() - DAY_MS) }])

    await expectMode('alert', 5000)
    await expect($('[data-testid="reminder-alert"]')).toHaveText(expect.stringContaining('llamar al banco'))

    await requestIntent('expand')
    await expectMode('reminders')
    const row = $(ITEM)
    await expect(row).toHaveAttribute('data-state', 'missed')
    await expect(row).toHaveText(expect.stringContaining('Perdido'))
  })

  it('Control Center rejects editing a reminder to a past date and keeps it unchanged', async () => {
    const future = new Date(Date.now() + DAY_MS)
    await start([{ text: 'revisar informe', dueAt: future }])
    const readStored = () =>
      (JSON.parse(readFileSync(join(dataDir(), 'reminders.json'), 'utf8')) as { reminders: { dueAt: string; text: string }[] }).reminders
    const stored = readStored()[0]!
    await openControlCenter()

    await $('//nav//button[normalize-space()="Recordatorios"]').click()
    const item = () => $(ITEM)
    await expect(item()).toHaveText(expect.stringContaining('revisar informe'))
    await item().$('button[aria-label^="Editar"]').click()

    // Date input plus a 24 h HH:mm text field, prefilled with the reminder's local date and time.
    const DATE = '[data-testid="reminder-edit-date"]'
    const TIME = '[data-testid="reminder-edit-time"]'
    await expect($(DATE)).toHaveValue(isoDate(future))
    await expect($(TIME)).toHaveValue(hhmm(future))
    await fillValue(DATE, '2020-01-01')
    await fillValue(TIME, '10:00')
    await $('//button[normalize-space()="Guardar"]').click()
    await expect($('[data-testid="reminder-edit-when-error"]')).toHaveText('La fecha ya pasó')
    await settle()

    const saved = readStored()
    expect(saved).toHaveLength(1)
    expect(saved[0]!.dueAt).toBe(stored.dueAt)
    expect(saved[0]!.text).toBe(stored.text)
  })

  it('row actions show on hover or keyboard focus only; a mouse-era programmatic focus never pins them', async () => {
    await start([
      { text: 'primera cosa', dueAt: new Date(Date.now() + 2 * DAY_MS) },
      { text: 'segunda cosa', dueAt: new Date(Date.now() + 3 * DAY_MS) },
    ])
    await requestIntent('expand')
    await $('[data-testid="integration-reminders"]').click()
    await expectMode('reminders')
    await expectItems(2)
    await settle()
    const nth = (index: number) => $(`(//*[@data-testid="reminder-item"])[${index + 1}]`)
    /** The row's actions overlay (the parent of its first button): its opacity. */
    const overlay = (index: number | 'focused'): Promise<string | null> =>
      inPage((which: number | string) => {
        type El = { querySelector(s: string): { parentElement: unknown } | null; contains(n: unknown): boolean }
        const w = globalThis as unknown as {
          document: { querySelectorAll(s: string): ArrayLike<El>; activeElement: unknown }
          getComputedStyle(el: unknown): { opacity: string }
        }
        const rows = Array.from(w.document.querySelectorAll('[data-testid="reminder-item"]'))
        const row = which === 'focused' ? rows.find((r) => r.contains(w.document.activeElement)) : rows[which as number]
        const parent = row?.querySelector('button')?.parentElement
        return parent ? w.getComputedStyle(parent).opacity : null
      }, index)
    const hidden = (index: number) => eventually(() => overlay(index), (o) => o === '0', `row ${index + 1}'s actions hidden`)
    const shown = (index: number | 'focused') => eventually(() => overlay(index), (o) => o === '1', `row ${index}'s actions shown`)

    await nth(0).moveTo()
    await shown(0)
    // Focus given by script right after the pointer was used is not keyboard focus: no sticky actions.
    // Once nothing moves (Playwright waits for a stable target; WebDriver clicks where it is now).
    await settle()
    await $('(//*[@data-testid="reminder-item"])[1]//*[normalize-space()="primera cosa"]').click()
    await expectItems(2)
    await inPage(() => {
      const row = (
        globalThis as unknown as { document: { querySelector(s: string): { querySelector(s: string): { focus(): void } | null } | null } }
      ).document.querySelector('[data-testid="reminder-item"]')
      row?.querySelector('button')?.focus()
    })
    await nth(1).moveTo()
    await shown(1)
    await pointerToCorner()
    await hidden(0)
    await hidden(1)

    // Keyboard focus inside a row reveals its actions with no hover.
    await browser.keys('Tab')
    const focusedRows = await inPage(() => {
      const doc = (
        globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ contains(n: unknown): boolean }>; activeElement: unknown } }
      ).document
      return Array.from(doc.querySelectorAll('[data-testid="reminder-item"]')).filter((r) => r.contains(doc.activeElement)).length
    })
    expect(focusedRows).toBe(1)
    await shown('focused')
  })
})
