/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Notes, ported from 0.1.0's Electron e2e notes.spec.ts. The system clipboard is read and written
// through `__e2e:clipboard` (Electron's `clipboard` in main); the user's text is put back.
import { $, $$, browser, expect } from '@wdio/globals'
import { DEFAULT_ALERTS, e2e, eventually, fillValue, inPage, launch, quitApp, requestIntent, seededSettings, setLanguage, settle } from './helpers'

const FIRST = 'Primera nota'
const FIRST_EDITED = 'Primera nota editada'
const SONG = 'Canción para la demo\nsegunda línea'

// The copy test reads the real system clipboard: keep what the user had and put it back.
let savedClipboard: string | null | undefined

const ITEM = '[data-testid="note-item"]'
const FIRST_ITEM = '(//*[@data-testid="note-item"])[1]'
const items = () => $$(ITEM)
const count = async () => (await items()).length
const expectCount = (n: number) => eventually(count, (value) => value === n, `${n} notes`)

/** The note row holding `text` (Playwright's `filter({ hasText })`). */
const row = (text: string) => $(`//*[@data-testid="note-item"][contains(., ${JSON.stringify(text)})]`)
const inRow = (text: string, testId: string) =>
  $(`//*[@data-testid="note-item"][contains(., ${JSON.stringify(text)})]//*[@data-testid="${testId}"]`)

/** The rows' texts, top to bottom (`locator('p').allInnerTexts()`). */
const texts = (): Promise<string[]> =>
  inPage(() =>
    Array.from(
      (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ innerText: string }> } }).document.querySelectorAll(
        '[data-testid="note-item"] p',
      ),
    ).map((p) => p.innerText),
  )

/** Whether some element's own text says "Copiado" or "Copied" (Playwright's `getByText`). */
const copiedShown = (): Promise<boolean> =>
  inPage(() =>
    Array.from(
      (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ innerText: string }> } }).document.querySelectorAll(
        'body *',
      ),
    ).some((el) => /Copiado|Copied/.test(el.innerText ?? '')),
  )

async function openNotes(): Promise<void> {
  await requestIntent('expand')
  await $('[data-testid="integration-notes"]').click()
  await $('[data-testid="notes-panel"]').waitForDisplayed()
}

/** Creates a note through the editor: "+", type, Ctrl+Enter. */
async function createNote(text: string): Promise<void> {
  await $('[data-testid="notes-add"]').click()
  await $('[data-testid="note-editor-text"]').waitForDisplayed()
  await fillValue('[data-testid="note-editor-text"]', text)
  await browser.keys(['Control', 'Enter'])
  await $('[data-testid="note-list"]').waitForDisplayed()
}

const restoreClipboard = async (): Promise<void> => {
  if (typeof savedClipboard === 'string') await e2e('clipboard', { text: savedClipboard })
  savedClipboard = undefined
}

describe('Notes (Tauri)', () => {
  afterEach(async () => {
    await restoreClipboard().catch(() => undefined)
  })

  after(async () => {
    await quitApp()
  })

  it('notes: create, search without accents, edit, pin, copy, delete with undo, persist across restart', async () => {
    await launch({ fresh: true, files: { 'settings.json': seededSettings(DEFAULT_ALERTS) } })
    savedClipboard = await e2e<string | null>('clipboard')
    await openNotes()
    await expect($('[data-testid="notes-empty"]')).toBeDisplayed()

    await createNote(FIRST)
    await createNote(SONG)
    // Most recently edited first.
    await expectCount(2)
    expect(await texts()).toEqual([SONG, FIRST])

    // Accent-insensitive search finds the note; Esc clears it.
    const search = '[data-testid="notes-search"]'
    await fillValue(search, 'cancion')
    await expectCount(1)
    await expect($(FIRST_ITEM)).toHaveText(expect.stringContaining('Canción para la demo'))
    await fillValue(search, 'zzz')
    await expect($('[data-testid="notes-no-results"]')).toBeDisplayed()
    await fillValue(search, '')
    await expectCount(2)

    // Edit: the editor opens with the text, saving updates the row.
    await row(FIRST).moveTo()
    await inRow(FIRST, 'note-edit').click()
    const field = () => $('[data-testid="note-editor-text"]')
    await expect(field()).toHaveValue(FIRST)
    await fillValue('[data-testid="note-editor-text"]', FIRST_EDITED)
    await settle()
    await browser.keys(['Control', 'Enter'])
    await $('[data-testid="note-list"]').waitForDisplayed()
    await eventually(() => $$(`//*[@data-testid="note-item"][contains(., "${FIRST_EDITED}")]`).length, (n) => n === 1, 'the edited row')
    // The edit moved it to the top (most recently edited).
    expect((await texts())[0]).toBe(FIRST_EDITED)

    // Pin the other one: it goes to the top and is marked pinned.
    await row('Canción').moveTo()
    await inRow('Canción', 'note-pin').click()
    await expect($(FIRST_ITEM)).toHaveText(expect.stringContaining('Canción para la demo'))
    await expect($(FIRST_ITEM)).toHaveAttribute('data-pinned', 'true')
    await expect($(`(//*[@data-testid="note-item"])[2]`)).toHaveAttribute('data-pinned', 'false')

    // Copy: the system clipboard holds the note text exactly.
    await row('Canción').moveTo()
    await inRow('Canción', 'note-copy').click()
    await eventually(copiedShown, (shown) => shown, 'the "Copiado" flash')
    expect(await e2e<string | null>('clipboard')).toBe(SONG)

    // Delete, then Deshacer restores it.
    await row(FIRST_EDITED).moveTo()
    await inRow(FIRST_EDITED, 'note-delete').click()
    await expectCount(1)
    await expect($('[data-testid="notes-undo"]')).toBeDisplayed()
    await $('[data-testid="notes-undo-button"]').click()
    await expectCount(2)
    await eventually(() => $$(`//*[@data-testid="note-item"][contains(., "${FIRST_EDITED}")]`).length, (n) => n === 1, 'the restored row')

    // Both languages (let the "Copiado" flash end so the rows show their times).
    await eventually(copiedShown, (shown) => !shown, 'the "Copiado" flash to end')
    await settle()
    await setLanguage('en')
    await expect($(search)).toHaveAttribute('placeholder', expect.stringMatching(/Search/i))
    await settle()
    await setLanguage('es')

    // Put the user's clipboard back now, from the app that changed it: if the second launch fails,
    // afterEach has no running app to restore it with.
    await restoreClipboard()

    // Restart with the same profile: notes (and the pin) are still there.
    await launch({ fresh: false })
    await openNotes()
    await expectCount(2)
    expect(await texts()).toEqual([SONG, FIRST_EDITED])
    await expect($(FIRST_ITEM)).toHaveAttribute('data-pinned', 'true')
  })
})
