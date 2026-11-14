import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }
interface Launch {
  kind: 'external' | 'spawn'
  file: string
  args?: readonly string[]
}

let userData: string

// The app runs with NOTCH_APP_LAUNCH_LOG=1: launches are recorded, never executed, so no test opens
// Claude Desktop, a browser or a terminal.
const launch = async (extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  env['NOTCH_APP_LAUNCH_LOG'] = '1'
  Object.assign(env, extra)
  const app = await electron.launch({ args: ['.'], env })
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.settings.update({ language: 'es' }))
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  return { app, notch }
}

const launches = (app: ElectronApplication): Promise<Launch[]> =>
  app.evaluate(() => [...((globalThis as unknown as { __notchAppLaunches?: Launch[] }).__notchAppLaunches ?? [])])

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
})

test.afterEach(() => {
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('la baldosa Claude abre el enlace de Claude Desktop y cierra el panel', async () => {
  const { app, notch } = await launch()
  await notch.getByTestId('integration-claude').click()
  await expect.poll(async () => (await launches(app)).at(-1)).toEqual({ kind: 'external', file: 'claude://claude.ai/new' })
  await expect(notch.getByTestId('notch-capsule')).not.toHaveAttribute('data-mode', 'expanded')
  await app.close()
})

test('la baldosa Terminal lanza Windows Terminal en la carpeta de usuario', async () => {
  const { app, notch } = await launch()
  const home = await app.evaluate(({ app: electronApp }) => electronApp.getPath('home'))
  await notch.getByTestId('integration-terminal').click()
  await expect.poll(async () => (await launches(app)).at(-1)?.kind).toBe('spawn')
  const last = (await launches(app)).at(-1)
  // Absolute paths only: a bare name would be resolved against the child's cwd first.
  expect(last?.file).toMatch(/^[a-z]:\\.*\\wt\.exe$/i)
  const args = last?.args ?? []
  expect(args.slice(0, 4)).toEqual(['-w', 'new', '-d', home])
  expect(args[4]).toMatch(/^[a-z]:\\.*\\(pwsh|powershell)\.exe$/i)
  expect(args[5]).toBe('-NoLogo')
  expect(args).toHaveLength(6)
  await expect(notch.getByTestId('notch-capsule')).not.toHaveAttribute('data-mode', 'expanded')
  await app.close()
})

test('doble clic en Claude abre una sola vez', async () => {
  const { app, notch } = await launch()
  await notch.getByTestId('integration-claude').dblclick()
  await expect.poll(async () => (await launches(app)).length).toBeGreaterThanOrEqual(1)
  await notch.waitForTimeout(300)
  expect(await launches(app)).toEqual([{ kind: 'external', file: 'claude://claude.ai/new' }])
  await app.close()
})

test('si Claude no se puede abrir, la línea de estado lo dice y se vacía sola', async () => {
  const { app, notch } = await launch({ NOTCH_APP_LAUNCH_FAIL: 'claude' })
  const line = notch.getByTestId('apps-open-failed')
  // Mounted before any failure, so a screen reader announces the text when it appears.
  await expect(line).toHaveCount(1)
  await expect(line).toHaveText('')
  await notch.getByTestId('integration-claude').click()
  await expect(line).toHaveText('No se pudo abrir Claude')
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  await settle(notch)
  const box = await line.boundingBox()
  const capsule = await notch.getByTestId('notch-capsule').boundingBox()
  expect(box).not.toBeNull()
  const tile = await notch.getByTestId('integration-claude').boundingBox()
  // Inside the panel and above the tiles (never over a control); the screenshot shows it clear of the clock.
  // The clock row ends before the failure line starts (no text over text).
  const clockBottom = await notch.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null; getBoundingClientRect(): { bottom: number } }> } }).document
    const el = Array.from(doc.querySelectorAll('span, time, div, p')).find((node) => /^[0-9]{2}:[0-9]{2}$/.test(node.textContent ?? ''))
    return el ? el.getBoundingClientRect().bottom : null
  })
  expect(clockBottom).not.toBeNull()
  expect(clockBottom!).toBeLessThanOrEqual(box!.y)
  expect(box!.y).toBeGreaterThanOrEqual(capsule!.y)
  expect(box!.y + box!.height).toBeLessThanOrEqual(tile!.y)
  await notch.screenshot({ path: 'test-results/apps-open-failed-es.png' })
  await app.close()
})

test('la línea de fallo se ve completa también con sesiones de Claude en el panel', async () => {
  const { app, notch } = await launch({ NOTCH_APP_LAUNCH_FAIL: 'claude' })
  const settingsFile = join(userData, 'claude-settings.json')
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const cc = await app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await cc.waitForLoadState('domcontentloaded')
  await cc.getByRole('button', { name: 'Claude Code' }).click()
  await cc.getByRole('button', { name: /Instalar hooks|Install hooks/ }).click()
  await cc.getByRole('button', { name: /Confirmar instalación|Confirm installation/ }).click()
  await expect.poll(() => readFileSync(settingsFile, 'utf8')).toContain('x-notch-hook')
  await cc.close()
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    hooks: Record<string, { hooks: { url?: string; headers?: Record<string, string> }[] }[]>
  }
  const hook = settings.hooks['PermissionRequest']?.[0]?.hooks[0]
  const url = new URL(hook!.url!)
  const token = hook!.headers!['x-notch-token']!
  for (const session of ['api-server', 'web-client']) {
    const body = JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', cwd: ['C:', 'work', session].join('\\') })
    await new Promise<void>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-notch-token': token } }, (res) => {
        res.resume()
        res.on('end', () => resolve())
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('claude-sessions')).toContainText('web-client')
  await notch.getByTestId('integration-claude').click()
  const line = notch.getByTestId('apps-open-failed')
  await expect(line).toHaveText('No se pudo abrir Claude')
  await settle(notch)
  const lineBox = await line.boundingBox()
  const capsuleBox = await notch.getByTestId('notch-capsule').boundingBox()
  const tileBox = await notch.getByTestId('integration-claude').boundingBox()
  // The clock row ends before the failure line starts (no text over text).
  const clockBottom = await notch.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null; getBoundingClientRect(): { bottom: number } }> } }).document
    const el = Array.from(doc.querySelectorAll('span, time, div, p')).find((node) => /^[0-9]{2}:[0-9]{2}$/.test(node.textContent ?? ''))
    return el ? el.getBoundingClientRect().bottom : null
  })
  expect(clockBottom).not.toBeNull()
  expect(clockBottom!).toBeLessThanOrEqual(lineBox!.y)
  expect(lineBox!.y).toBeGreaterThanOrEqual(capsuleBox!.y)
  expect(lineBox!.y + lineBox!.height).toBeLessThanOrEqual(tileBox!.y)
  await notch.screenshot({ path: 'test-results/apps-open-failed-sessions-es.png' })
  await app.close()
})
