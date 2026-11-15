/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// The Claude and Terminal tiles, ported from tests/e2e/apps.spec.ts (Electron). The app runs with
// NOTCH_APP_LAUNCH_LOG=1: launches are recorded, never executed, so no test opens Claude Desktop, a
// browser or a terminal. `__e2e:app-launches` reads the record (`__notchAppLaunches` in Electron)
// and the user folder (`app.getPath('home')`).
import { $, $$, browser, expect } from '@wdio/globals'
import { clockBottom, e2e, eventually, inPage, launch, quitApp, rectOf, requestIntent, setLanguage, settle } from './helpers'

interface Launch {
  kind: 'external' | 'spawn'
  file: string
  args?: readonly string[]
}

const capsule = () => $('[data-testid="notch-capsule"]')
const launches = async (): Promise<Launch[]> => (await e2e<{ launches: Launch[] }>('app-launches')).launches

const start = async (extra: Record<string, string> = {}): Promise<void> => {
  await launch({ fresh: true, env: { NOTCH_APP_LAUNCH_LOG: '1', ...extra } })
  // The recorder must be on before any tile is clicked (UNAVAILABLE otherwise): never a real launch.
  expect(await launches()).toEqual([])
  await setLanguage('es')
  await requestIntent('expand')
  await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
}

/** The failure line's text (`textContent`: WebDriver's visible text skips an empty, zero-size line). */
const lineText = (): Promise<string | null> =>
  inPage(
    () =>
      (
        globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }
      ).document.querySelector('[data-testid="apps-open-failed"]')?.textContent ?? null,
  )

/** The failure line sits inside the panel, below the clock and above the tiles. */
async function expectLineClear(): Promise<void> {
  await settle()
  const box = await rectOf('[data-testid="apps-open-failed"]')
  const panel = await rectOf('[data-testid="notch-capsule"]')
  const tile = await rectOf('[data-testid="integration-claude"]')
  if (!box || !panel || !tile) throw new Error('missing failure line, panel or tile')
  // The clock row ends before the failure line starts (no text over text).
  const bottom = await clockBottom()
  expect(bottom).not.toBeNull()
  expect(bottom!).toBeLessThanOrEqual(box.y)
  expect(box.y).toBeGreaterThanOrEqual(panel.y)
  expect(box.y + box.height).toBeLessThanOrEqual(tile.y)
}

describe('Apps (Tauri)', () => {
  after(async () => {
    await quitApp()
  })

  it('la baldosa Claude abre el enlace de Claude Desktop y cierra el panel', async () => {
    await start()
    await $('[data-testid="integration-claude"]').click()
    await eventually(
      async () => (await launches()).at(-1),
      (last) => last?.kind === 'external' && last.file === 'claude://claude.ai/new' && Object.keys(last).length === 2,
      'the Claude launch',
    )
    await eventually(() => capsule().getAttribute('data-mode'), (mode) => mode !== 'expanded', 'the panel to close')
  })

  it('la baldosa Terminal lanza Windows Terminal en la carpeta de usuario', async () => {
    await start()
    const { home } = await e2e<{ home: string }>('app-launches')
    await $('[data-testid="integration-terminal"]').click()
    await eventually(async () => (await launches()).at(-1)?.kind, (kind) => kind === 'spawn', 'the terminal launch')
    const last = (await launches()).at(-1)
    // Absolute paths only: a bare name would be resolved against the child's cwd first.
    expect(last?.file).toMatch(/^[a-z]:\\.*\\wt\.exe$/i)
    const args = last?.args ?? []
    expect(args.slice(0, 4)).toEqual(['-w', 'new', '-d', home])
    expect(args[4]).toMatch(/^[a-z]:\\.*\\(pwsh|powershell)\.exe$/i)
    expect(args[5]).toBe('-NoLogo')
    expect(args).toHaveLength(6)
    await eventually(() => capsule().getAttribute('data-mode'), (mode) => mode !== 'expanded', 'the panel to close')
  })

  it('doble clic en Claude abre una sola vez', async () => {
    await start()
    // Once the panel has stopped growing, so both clicks land on the tile.
    await settle()
    await $('[data-testid="integration-claude"]').doubleClick()
    await eventually(async () => (await launches()).length, (count) => count >= 1, 'a launch')
    await browser.pause(300)
    expect(await launches()).toEqual([{ kind: 'external', file: 'claude://claude.ai/new' }])
  })

  it('si Claude no se puede abrir, la línea de estado lo dice y se vacía sola', async () => {
    await start({ NOTCH_APP_LAUNCH_FAIL: 'claude' })
    // Mounted before any failure, so a screen reader announces the text when it appears.
    await expect($$('[data-testid="apps-open-failed"]')).toBeElementsArrayOfSize(1)
    expect(await lineText()).toBe('')
    await $('[data-testid="integration-claude"]').click()
    await eventually(lineText, (text) => text === 'No se pudo abrir Claude', 'the failure line')
    await expect(capsule()).toHaveAttribute('data-mode', 'expanded')
    // Inside the panel and above the tiles (never over a control), clear of the clock.
    await expectLineClear()
  })

  it('la línea de fallo se ve completa también con sesiones de Claude en el panel', async () => {
    await start({ NOTCH_APP_LAUNCH_FAIL: 'claude' })
    // GAP: Electron installs the Claude Code hooks from the Control Center and posts two sessions
    // to the hook server, so the panel lists them above the tiles. Claude is part 3 (its channels
    // answer UNAVAILABLE): the panel has no sessions here, and only the failure line's layout in
    // the panel part 2 draws is checked.
    await $('[data-testid="integration-claude"]').click()
    await eventually(lineText, (text) => text === 'No se pudo abrir Claude', 'the failure line')
    await expectLineClear()
  })
})
