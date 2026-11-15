import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }
type HookReply = { status: number; body: string }
type Endpoint = { url: URL; token: string }
/** Claude's two hook URLs: `/hook` (every event, answered at once) and `/hook/question` (held AskUserQuestion). */
type Bridge = { hook: Endpoint; question: Endpoint }

type Option = { label: string; description: string }
type Question = { question: string; header: string; multiSelect: boolean; options: Option[] }
type ToolInput = { questions: Question[] } & Record<string, unknown>

const NO_DECISION = '{}'
const ALLOW_PERMISSION = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY_PERMISSION = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'

let userData: string
let settingsFile: string
let launched: ElectronApplication | undefined

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Never touch the real ~/.claude/settings.json nor collide with an installed notch on 47600.
  env['NOTCH_CLAUDE_SETTINGS'] = settingsFile
  env['NOTCH_CLAUDE_PORT'] = '0'
  // "Responder en Claude" must not bring the user's real Claude window forward.
  env['NOTCH_DISABLE_CLAUDE_FOCUS'] = '1'
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  await setLanguage(notch, 'es')
  return { app, notch }
}

const setLanguage = (notch: Page, language: 'es' | 'en') =>
  notch.evaluate((lang) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: lang }), language)

/** Installs the hooks through the Control Center UI, like a user would, and reads the URLs Claude would use. */
const installHooks = async (app: ElectronApplication, notch: Page): Promise<Bridge> => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const cc = await app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await cc.waitForLoadState('domcontentloaded')
  await cc.getByRole('button', { name: 'Claude Code' }).click()
  await cc.getByRole('button', { name: /Instalar hooks|Install hooks/ }).click()
  await cc.getByRole('button', { name: /Confirmar instalación|Confirm installation/ }).click()
  await expect.poll(() => readFileSync(settingsFile, 'utf8')).toContain('x-notch-hook')
  await cc.close()

  type Hook = { type: string; url?: string; headers?: Record<string, string> }
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { hooks: Record<string, { matcher?: string; hooks: Hook[] }[]> }
  const endpoint = (hook: Hook | undefined): Endpoint => {
    if (!hook?.url || !hook.headers?.['x-notch-token']) throw new Error('Hooks are not installed')
    return { url: new URL(hook.url), token: hook.headers['x-notch-token'] }
  }
  const hook = endpoint(settings.hooks['PermissionRequest']?.[0]?.hooks[0])
  const question = endpoint(settings.hooks['PreToolUse']?.find((group) => group.matcher === 'AskUserQuestion')?.hooks[0])
  expect(hook.url.pathname).toBe('/hook')
  expect(question.url.pathname).toBe('/hook/question')
  return { hook, question }
}

/** POSTs a hook payload like Claude Code does. The promise settles when the bridge replies. */
const post = (endpoint: Endpoint, payload: Record<string, unknown>): Promise<HookReply> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = request(
      endpoint.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-notch-token': endpoint.token,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })

const event = (session: string, name: string, extra: Record<string, unknown> = {}) => ({
  session_id: session,
  hook_event_name: name,
  cwd: `C:\\work\\${session}`,
  ...extra,
})

const askEvent = (session: string, toolUseId: string, toolInput: ToolInput) =>
  event(session, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: toolUseId, tool_input: toolInput })

/** Resolves with the reply, or 'pending' if none arrived within `ms`. */
const settledWithin = (reply: Promise<HookReply>, ms: number): Promise<HookReply | 'pending'> =>
  Promise.race([reply, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))])

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')

/**
 * Sends one AskUserQuestion the way Claude does: the same PreToolUse to both of our groups. /hook answers
 * at once (no decision); the /hook/question reply is held until the user answers. Boxed: returning the
 * bare promise would await it.
 */
const ask = async (notch: Page, bridge: Bridge, session: string, toolUseId: string, toolInput: ToolInput) => {
  const payload = askEvent(session, toolUseId, toolInput)
  const reply = post(bridge.question, payload)
  const plain = await settledWithin(post(bridge.hook, payload), 1000)
  expect(plain).toEqual({ status: 200, body: '' })
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert', { timeout: 1000 })
  return { reply }
}

const expandTo = async (notch: Page, mode: 'question' | 'permission') => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', mode)
}

const answerBody = (toolInput: ToolInput, answers: Record<string, string>) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } } })

const options = (notch: Page): Locator => notch.getByTestId('claude-question-option')
const sendButton = (notch: Page): Locator => notch.getByTestId('claude-question-send')

const readLog = (): string => {
  const dir = join(userData, 'logs')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

// --- Payloads ------------------------------------------------------------------------

const SINGLE: ToolInput = {
  questions: [
    {
      question: '¿Qué base de datos usamos para el servicio de pedidos?',
      header: 'Base de datos',
      multiSelect: false,
      options: [
        { label: 'PostgreSQL', description: 'Relacional, transacciones y JSONB para los campos variables.' },
        { label: 'SQLite', description: 'Un archivo local; suficiente para el prototipo.' },
        { label: 'MongoDB', description: 'Documentos flexibles, sin esquema fijo.' },
      ],
    },
  ],
  // Keys Claude may add that the notch does not know: echoed back untouched.
  metadata: { source: 'e2e-unknown-key' },
}

const MULTI: ToolInput = {
  questions: [
    {
      question: '¿Qué capas de caché quieres para las respuestas de la API de facturación?',
      header: 'Caché',
      multiSelect: true,
      options: [
        { label: 'Memoria del proceso', description: 'Un LRU por instancia: lo más rápido, pero cada réplica tiene su copia y se pierde al reiniciar.' },
        { label: 'Redis compartido', description: 'Una caché común a todas las réplicas, con invalidación por clave al cambiar una factura.' },
        { label: 'Cabeceras HTTP', description: 'Cache-Control y ETag para que el navegador y la CDN eviten peticiones repetidas.' },
        { label: 'Sin caché', description: 'Mantener las consultas directas a la base de datos y medir antes de decidir.' },
      ],
    },
  ],
}

const TWO: ToolInput = {
  questions: [
    { question: '¿Cómo nombro la rama?', header: 'Rama', multiSelect: false, options: [
      { label: 'feat/orders-service', description: '' },
      { label: 'orders-v2', description: '' },
    ] },
    { question: '¿Publico el cambio cuando termine?', header: 'Publicar', multiSelect: false, options: [
      { label: 'Sí, abre un PR', description: 'Con la descripción y la lista de cambios.' },
      { label: 'No, déjalo en local', description: 'Lo reviso yo antes de subir nada.' },
    ] },
  ],
}

const FOUR: ToolInput = {
  questions: [
    SINGLE.questions[0]!,
    { question: '¿Qué pruebas añado ahora?', header: 'Pruebas', multiSelect: true, options: [
      { label: 'Unitarias', description: 'Reglas de negocio del carrito y de los descuentos.' },
      { label: 'Integración', description: 'Repositorio contra una base de datos real en Docker.' },
      { label: 'E2E', description: 'Flujo completo de compra con Playwright.' },
      { label: 'Carga', description: '100 pedidos por segundo durante 5 minutos.' },
    ] },
    ...TWO.questions,
  ],
}

const OTHER_TEXT = 'Caché en el cliente con SWR'

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
  settingsFile = join(userData, 'claude-settings.json')
})

test.afterEach(async () => {
  // A failed test must not leave Electron holding the temp profile.
  await launched?.close().catch(() => undefined)
  launched = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('a question raises the alert; one option and Enviar answer allow with the original input and answers', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)
  await post(bridge.hook, event('pedidos', 'UserPromptSubmit'))

  const { reply } = await ask(notch, bridge, 'pedidos', 'toolu_single', SINGLE)
  const alert = notch.getByTestId('claude-question-alert')
  await expect(alert).toContainText('Claude te pregunta')
  await expect(alert).toContainText('pedidos')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/claude-question-alert-es.png' })
  expect(await settledWithin(reply, 300)).toBe('pending')

  await expandTo(notch, 'question')
  const card = notch.getByTestId('claude-question')
  await expect(card).toContainText(SINGLE.questions[0]!.question)
  await expect(sendButton(notch)).toBeDisabled()
  await options(notch).nth(1).click()
  await expect(options(notch).nth(1)).toHaveAttribute('aria-checked', 'true')
  await sendButton(notch).click()

  const answer = await reply
  expect(answer.status).toBe(200)
  expect(answer.body).toBe(answerBody(SINGLE, { [SINGLE.questions[0]!.question]: 'SQLite' }))
  await expect(notch.getByTestId('claude-question-sent')).toBeVisible()
  await expect(notch.getByTestId('claude-question-status')).toHaveText('Respuesta enviada')
  await expect(card).toBeHidden({ timeout: 4000 })
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', /alert|question/)
  await app.close()
  launched = undefined

  // Ids, counts and results only: no question, option or answer text reaches the log.
  const log = readLog()
  expect(log).toContain('Claude question answered')
  for (const text of [SINGLE.questions[0]!.question, 'SQLite', 'PostgreSQL', 'Base de datos', 'Relacional', 'e2e-unknown-key']) {
    expect(log).not.toContain(text)
  }
})

test('multiSelect joins the picked labels in option order and appends "Otro" last; screenshots ES/EN', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  const { reply } = await ask(notch, bridge, 'facturacion-api', 'toolu_multi', MULTI)
  await expandTo(notch, 'question')
  // Picked out of order: the answer still follows the options.
  await options(notch).nth(2).click()
  await options(notch).nth(0).click()
  await options(notch).nth(4).click()
  const other = notch.getByTestId('claude-question-other')
  await expect(other).toBeFocused()
  await expect(sendButton(notch)).toBeDisabled()
  await notch.keyboard.type(OTHER_TEXT)
  await expect(sendButton(notch)).toBeEnabled()
  // The field says which question it answers.
  const describedBy = await other.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(notch.locator(`[id="${describedBy}"]`)).toHaveText(MULTI.questions[0]!.question)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/claude-question-es.png' })

  await setLanguage(notch, 'en')
  await expect(notch.getByTestId('claude-question')).toContainText('Claude asks')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/claude-question-en.png' })
  await setLanguage(notch, 'es')
  await expect(notch.getByTestId('claude-question')).toContainText('Claude te pregunta')

  await other.focus()
  await notch.keyboard.press('Control+Enter')
  const answer = await reply
  expect(answer.status).toBe(200)
  expect(answer.body).toBe(answerBody(MULTI, { [MULTI.questions[0]!.question]: `Memoria del proceso, Cabeceras HTTP, ${OTHER_TEXT}` }))
  await expect(notch.getByTestId('claude-question')).toBeHidden({ timeout: 4000 })
  await app.close()
  launched = undefined
  expect(readLog()).not.toContain(OTHER_TEXT)
})

test('four questions: screenshot, and "Otro" alone answers a single-choice question', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  const { reply } = await ask(notch, bridge, 'tienda-pedidos', 'toolu_four', FOUR)
  await expandTo(notch, 'question')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/claude-question-4q-es.png' })

  // Option groups: 3+1, 4+1, 2+1, 2+1 items ("Otro…" last in each).
  const all = options(notch)
  await expect(all).toHaveCount(15)
  await all.nth(0).click() // PostgreSQL
  await all.nth(5).click() // Integración
  await all.nth(6).click() // E2E
  await all.nth(11).click() // Otro… (rama)
  await notch.keyboard.type('feat/pedidos')
  await all.nth(13).click() // No, déjalo en local
  await expect(notch.getByTestId('claude-question-other')).toHaveCount(1)
  await sendButton(notch).click()

  const answer = await reply
  expect(answer.body).toBe(
    answerBody(FOUR, {
      [FOUR.questions[0]!.question]: 'PostgreSQL',
      [FOUR.questions[1]!.question]: 'Integración, E2E',
      [FOUR.questions[2]!.question]: 'feat/pedidos',
      [FOUR.questions[3]!.question]: 'No, déjalo en local',
    }),
  )
  await app.close()
})

test('keyboard: Enter never sends, Ctrl+Enter needs a complete form and sends once, Esc keeps it pending', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  const { reply } = await ask(notch, bridge, 'pedidos', 'toolu_keys', TWO)
  await expandTo(notch, 'question')
  // Initial focus: the first option of the first question. Space picks it.
  await expect(options(notch).nth(0)).toBeFocused()
  await notch.keyboard.press('Space')
  await expect(options(notch).nth(0)).toHaveAttribute('aria-checked', 'true')

  // Enter on an option (and Ctrl+Enter) with the second question unanswered: nothing is sent.
  await notch.keyboard.press('Enter')
  await notch.keyboard.press('Control+Enter')
  expect(await settledWithin(reply, 700)).toBe('pending')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'question')

  // Tab to the second question, Down + Space picks its second option.
  await notch.keyboard.press('Tab')
  await expect(options(notch).nth(3)).toBeFocused()
  await notch.keyboard.press('ArrowDown')
  await notch.keyboard.press('Space')
  await expect(options(notch).nth(4)).toHaveAttribute('aria-checked', 'true')
  await expect(sendButton(notch)).toBeEnabled()

  // Enter on a focused option still never sends, even with the form complete.
  await notch.keyboard.press('Enter')
  expect(await settledWithin(reply, 700)).toBe('pending')

  // Esc closes without answering: the question stays pending and the alert comes back.
  await notch.keyboard.press('Escape')
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  expect(await settledWithin(reply, 500)).toBe('pending')

  // Reopened: a fresh form. Two quick Ctrl+Enter send once.
  await expandTo(notch, 'question')
  await options(notch).nth(1).click()
  await options(notch).nth(3).click()
  await notch.keyboard.press('Control+Enter')
  await notch.keyboard.press('Control+Enter')
  const answer = await reply
  expect(answer.body).toBe(answerBody(TWO, { [TWO.questions[0]!.question]: 'orders-v2', [TWO.questions[1]!.question]: 'Sí, abre un PR' }))
  await expect(notch.getByTestId('claude-question')).toBeHidden({ timeout: 4000 })
  await app.close()
  launched = undefined
  expect(readLog().match(/Claude question answered/g) ?? []).toHaveLength(1)
})

test('"Responder en Claude" hands the question back with {}', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  const { reply } = await ask(notch, bridge, 'pedidos', 'toolu_reply', SINGLE)
  await expandTo(notch, 'question')
  await notch.getByTestId('claude-question-reply').click()
  expect(await reply).toEqual({ status: 200, body: NO_DECISION })
  await expect(notch.getByTestId('claude-question')).toBeHidden()
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', /alert|question/)
  await app.close()
})

test('a Stop of the session releases the question with {} and the card and alert go away', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  // Panel closed: the alert goes.
  const first = await ask(notch, bridge, 'pedidos', 'toolu_stop1', SINGLE)
  expect((await post(bridge.hook, event('pedidos', 'Stop'))).status).toBe(200)
  expect(await first.reply).toEqual({ status: 200, body: NO_DECISION })
  await expect(notch.getByTestId('claude-question-alert')).toBeHidden()
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', 'alert')

  // Panel open: the card says it is no longer pending, then closes.
  const second = await ask(notch, bridge, 'pedidos', 'toolu_stop2', SINGLE)
  await expandTo(notch, 'question')
  // A Stop of another session does not touch it.
  await post(bridge.hook, event('otra-sesion', 'Stop'))
  expect(await settledWithin(second.reply, 500)).toBe('pending')
  await post(bridge.hook, event('pedidos', 'Stop'))
  expect(await second.reply).toEqual({ status: 200, body: NO_DECISION })
  await expect(notch.getByTestId('claude-question-gone')).toBeVisible()
  await expect(notch.getByTestId('claude-question-status')).toHaveText('Esta pregunta ya no está pendiente')
  await expect(notch.getByTestId('claude-question')).toBeHidden({ timeout: 4000 })
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', /alert|question/)
  await app.close()
})

test('permission first, then a question of another session: the permission opens first', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  const permission = post(bridge.hook, event('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert')
  const { reply } = await ask(notch, bridge, 'pedidos', 'toolu_after', SINGLE)

  await expandTo(notch, 'permission')
  const allow = notch.getByTestId('claude-allow')
  await expect(allow).toBeEnabled({ timeout: 3000 })
  await allow.click()
  expect(await permission).toEqual({ status: 200, body: ALLOW_PERMISSION })

  // The panel moves on to the question.
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'question')
  await options(notch).nth(0).click()
  await sendButton(notch).click()
  expect((await reply).body).toBe(answerBody(SINGLE, { [SINGLE.questions[0]!.question]: 'PostgreSQL' }))
  await expect(notch.getByTestId('claude-question')).toBeHidden({ timeout: 4000 })
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', /alert|question|permission/)
  await app.close()
})

test('question first, then a permission of another session: the question opens first', async () => {
  const { app, notch } = await launch()
  const bridge = await installHooks(app, notch)

  const { reply } = await ask(notch, bridge, 'pedidos', 'toolu_before', SINGLE)
  const permission = post(bridge.hook, event('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }))
  expect(await settledWithin(permission, 300)).toBe('pending')

  await expandTo(notch, 'question')
  await options(notch).nth(2).click()
  await sendButton(notch).click()
  expect((await reply).body).toBe(answerBody(SINGLE, { [SINGLE.questions[0]!.question]: 'MongoDB' }))
  await expect(notch.getByTestId('claude-question-sent')).toBeVisible()

  // After "Respuesta enviada", the panel moves on to the permission.
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'permission', { timeout: 4000 })
  const deny = notch.getByTestId('claude-deny')
  await expect(deny).toBeEnabled({ timeout: 3000 })
  await deny.click()
  expect(await permission).toEqual({ status: 200, body: DENY_PERMISSION })
  await expect(capsule(notch)).not.toHaveAttribute('data-mode', /alert|question|permission/)
  await app.close()
})
