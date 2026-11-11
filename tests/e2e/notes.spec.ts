import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }

const FIRST = 'Primera nota'
const FIRST_EDITED = 'Primera nota editada'
const SONG = 'Canción para la demo\nsegunda línea'

let userData: string
let launched: ElectronApplication | undefined
// The copy test reads the real system clipboard through main: keep what the user had and put it back.
let savedClipboard: string | undefined

const writeSettings = (): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 3,
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
    }),
    'utf8',
  )
}

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Stay isolated from an installed notch and from the real ~/.claude/settings.json.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const setLanguage = (notch: Page, language: 'es' | 'en') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)

const openNotes = async (notch: Page): Promise<void> => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await notch.getByTestId('integration-notes').click()
  await expect(notch.getByTestId('notes-panel')).toBeVisible()
}

/** Creates a note through the editor: "+", type, Ctrl+Enter. */
const createNote = async (notch: Page, text: string): Promise<void> => {
  await notch.getByTestId('notes-add').click()
  const field = notch.getByTestId('note-editor-text')
  await field.fill(text)
  await field.press('Control+Enter')
  await expect(notch.getByTestId('note-list')).toBeVisible()
}

const row = (notch: Page, text: string): Locator => notch.getByTestId('note-item').filter({ hasText: text })

const texts = (notch: Page): Promise<string[]> => notch.getByTestId('note-item').locator('p').allInnerTexts()

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
  writeSettings()
  savedClipboard = undefined
})

test.afterEach(async () => {
  if (savedClipboard !== undefined && launched) {
    const text = savedClipboard
    await launched.evaluate(({ clipboard }, value) => clipboard.writeText(value), text).catch(() => undefined)
  }
  // A failed test must not leave Electron holding the temp profile.
  await launched?.close().catch(() => undefined)
  launched = undefined
  savedClipboard = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('notes: create, search without accents, edit, pin, copy, delete with undo, persist across restart', async () => {
  const first = await launch()
  const { app, notch } = first
  savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  await openNotes(notch)
  await expect(notch.getByTestId('notes-empty')).toBeVisible()

  await createNote(notch, FIRST)
  await createNote(notch, SONG)
  // Most recently edited first.
  await expect(notch.getByTestId('note-item')).toHaveCount(2)
  expect(await texts(notch)).toEqual([SONG, FIRST])

  // Accent-insensitive search finds the note; Esc clears it.
  const search = notch.getByTestId('notes-search')
  await search.fill('cancion')
  await expect(notch.getByTestId('note-item')).toHaveCount(1)
  await expect(notch.getByTestId('note-item')).toContainText('Canción para la demo')
  await search.fill('zzz')
  await expect(notch.getByTestId('notes-no-results')).toBeVisible()
  await search.fill('')
  await expect(notch.getByTestId('note-item')).toHaveCount(2)

  // Edit: the editor opens with the text, saving updates the row.
  await row(notch, FIRST).hover()
  await row(notch, FIRST).getByTestId('note-edit').click()
  const field = notch.getByTestId('note-editor-text')
  await expect(field).toHaveValue(FIRST)
  await field.fill(FIRST_EDITED)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/notes-editor.png' })
  await field.press('Control+Enter')
  await expect(notch.getByTestId('note-list')).toBeVisible()
  await expect(row(notch, FIRST_EDITED)).toHaveCount(1)
  // The edit moved it to the top (most recently edited).
  expect((await texts(notch))[0]).toBe(FIRST_EDITED)

  // Pin the other one: it goes to the top and is marked pinned.
  await row(notch, 'Canción').hover()
  await row(notch, 'Canción').getByTestId('note-pin').click()
  await expect(notch.getByTestId('note-item').first()).toContainText('Canción para la demo')
  await expect(notch.getByTestId('note-item').first()).toHaveAttribute('data-pinned', 'true')
  await expect(notch.getByTestId('note-item').nth(1)).toHaveAttribute('data-pinned', 'false')

  // Copy: the system clipboard holds the note text exactly.
  await row(notch, 'Canción').hover()
  await row(notch, 'Canción').getByTestId('note-copy').click()
  await expect(notch.getByText(/Copiado|Copied/).first()).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(SONG)

  // Delete, then Deshacer restores it.
  await row(notch, FIRST_EDITED).hover()
  await row(notch, FIRST_EDITED).getByTestId('note-delete').click()
  await expect(notch.getByTestId('note-item')).toHaveCount(1)
  await expect(notch.getByTestId('notes-undo')).toBeVisible()
  await notch.getByTestId('notes-undo-button').click()
  await expect(notch.getByTestId('note-item')).toHaveCount(2)
  await expect(row(notch, FIRST_EDITED)).toHaveCount(1)

  // List screenshots, both languages (let the "Copiado" flash end so the rows show their times).
  await expect(notch.getByText(/Copiado|Copied/)).toHaveCount(0)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/notes-list-es.png' })
  await setLanguage(notch, 'en')
  await expect(notch.getByTestId('notes-search')).toHaveAttribute('placeholder', /Search/i)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/notes-list-en.png' })
  await setLanguage(notch, 'es')

  // Put the user's clipboard back now, from the app that changed it: if the second launch fails,
  // afterEach has no running app to restore it with.
  if (savedClipboard !== undefined) {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), savedClipboard)
  }

  // Restart with the same profile: notes (and the pin) are still there.
  await first.app.close()
  launched = undefined
  const second = await launch()
  await openNotes(second.notch)
  await expect(second.notch.getByTestId('note-item')).toHaveCount(2)
  expect(await texts(second.notch)).toEqual([SONG, FIRST_EDITED])
  await expect(second.notch.getByTestId('note-item').first()).toHaveAttribute('data-pinned', 'true')
})
