/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />
// Claude Code questions (AskUserQuestion), ported from tests/e2e/claude-questions.spec.ts
// (Electron). Same isolation as claude.spec.ts: a temp settings.json checked before anything runs,
// an ephemeral bridge port, hooks installed through the Control Center and POSTed with Node's
// `http`; `NOTCH_DISABLE_CLAUDE_FOCUS=1` so "Responder en Claude" never brings the user's real
// Claude window forward. The logs are `<profile>/logs/main.log` (and its rotations).
//
// GAP: the Electron spec also saves screenshots (test-results/claude-question-*.png); they are not
// assertions and are left out here, as in the other Tauri specs.
import { $, $$, browser, expect } from '@wdio/globals'
import {
  claudeSettingsFile,
  eventually,
  hookEvent,
  inPage,
  installClaudeHooks,
  launchClaude,
  postHook,
  quitApp,
  readLogs,
  requestIntent,
  setLanguage,
  settledWithin,
  settle,
  type ClaudeBridge,
  type HookReply,
} from './helpers'

type Option = { label: string; description: string }
type Question = { question: string; header: string; multiSelect: boolean; options: Option[] }
type ToolInput = { questions: Question[] } & Record<string, unknown>

const NO_DECISION = '{}'
const ALLOW_PERMISSION = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY_PERMISSION = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'

const capsule = () => $('[data-testid="notch-capsule"]')
const mode = () => capsule().getAttribute('data-mode')
const byTestId = (id: string) => $(`[data-testid="${id}"]`)
const option = (index: number) => $(`(//*[@data-testid="claude-question-option"])[${index + 1}]`)
const options = () => $$('[data-testid="claude-question-option"]')
const sendButton = () => byTestId('claude-question-send')

const start = async (): Promise<ClaudeBridge> => {
  await launchClaude()
  await setLanguage('es')
  return installClaudeHooks()
}

const askEvent = (session: string, toolUseId: string, toolInput: ToolInput) =>
  hookEvent(session, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: toolUseId, tool_input: toolInput })

/**
 * Sends one AskUserQuestion the way Claude does: the same PreToolUse to both of our groups. /hook answers
 * at once (no decision); the /hook/question reply is held until the user answers. Boxed: returning the
 * bare promise would await it.
 */
async function ask(bridge: ClaudeBridge, session: string, toolUseId: string, toolInput: ToolInput): Promise<{ reply: Promise<HookReply> }> {
  const payload = askEvent(session, toolUseId, toolInput)
  const reply = postHook(bridge.question, payload)
  const plain = await settledWithin(postHook(bridge.hook, payload), 1000)
  expect(plain).toEqual({ status: 200, body: '' })
  await expect(capsule()).toHaveAttribute('data-mode', 'alert', { wait: 1000 })
  return { reply }
}

const expandTo = async (value: 'question' | 'permission') => {
  await requestIntent('expand')
  await expect(capsule()).toHaveAttribute('data-mode', value)
}

/** The capsule leaves every mode matching `pattern`. */
const leaves = (pattern: RegExp) => eventually(mode, (value) => !pattern.test(value ?? ''), `the capsule to leave ${pattern}`)

const answerBody = (toolInput: ToolInput, answers: Record<string, string>) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } } })

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
    {
      question: '¿Cómo nombro la rama?',
      header: 'Rama',
      multiSelect: false,
      options: [
        { label: 'feat/orders-service', description: '' },
        { label: 'orders-v2', description: '' },
      ],
    },
    {
      question: '¿Publico el cambio cuando termine?',
      header: 'Publicar',
      multiSelect: false,
      options: [
        { label: 'Sí, abre un PR', description: 'Con la descripción y la lista de cambios.' },
        { label: 'No, déjalo en local', description: 'Lo reviso yo antes de subir nada.' },
      ],
    },
  ],
}

const FOUR: ToolInput = {
  questions: [
    SINGLE.questions[0]!,
    {
      question: '¿Qué pruebas añado ahora?',
      header: 'Pruebas',
      multiSelect: true,
      options: [
        { label: 'Unitarias', description: 'Reglas de negocio del carrito y de los descuentos.' },
        { label: 'Integración', description: 'Repositorio contra una base de datos real en Docker.' },
        { label: 'E2E', description: 'Flujo completo de compra con Playwright.' },
        { label: 'Carga', description: '100 pedidos por segundo durante 5 minutos.' },
      ],
    },
    ...TWO.questions,
  ],
}

const OTHER_TEXT = 'Caché en el cliente con SWR'

/** Whether the focused element is the one matching `selector`. */
const isFocused = (selector: string): Promise<boolean> =>
  inPage((sel: string) => {
    const doc = (globalThis as unknown as { document: { activeElement: unknown; querySelector(s: string): unknown } }).document
    return doc.activeElement !== null && doc.activeElement === doc.querySelector(sel)
  }, selector)

/** Whether the focused element is the `index`-th option. */
const optionFocused = (index: number): Promise<boolean> =>
  inPage((i: number) => {
    const doc = (globalThis as unknown as { document: { activeElement: unknown; querySelectorAll(s: string): ArrayLike<unknown> } }).document
    return doc.querySelectorAll('[data-testid="claude-question-option"]')[i] === doc.activeElement
  }, index)

describe('Claude Code questions (Tauri)', () => {
  beforeEach(() => {
    // Fail fast: Claude's settings.json must be a file of this run's temp profile.
    claudeSettingsFile()
  })

  after(async () => {
    await quitApp()
  })

  it('a question raises the alert; one option and Enviar answer allow with the original input and answers', async () => {
    const bridge = await start()
    await postHook(bridge.hook, hookEvent('pedidos', 'UserPromptSubmit'))

    const { reply } = await ask(bridge, 'pedidos', 'toolu_single', SINGLE)
    const alert = byTestId('claude-question-alert')
    await expect(alert).toHaveText(expect.stringContaining('Claude te pregunta'))
    await expect(alert).toHaveText(expect.stringContaining('pedidos'))
    await settle()
    expect(await settledWithin(reply, 300)).toBe('pending')

    await expandTo('question')
    const card = byTestId('claude-question')
    await expect(card).toHaveText(expect.stringContaining(SINGLE.questions[0]!.question))
    expect(await sendButton().isEnabled()).toBe(false)
    await option(1).click()
    await expect(option(1)).toHaveAttribute('aria-checked', 'true')
    await sendButton().click()

    const answer = await reply
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(answerBody(SINGLE, { [SINGLE.questions[0]!.question]: 'SQLite' }))
    await byTestId('claude-question-sent').waitForDisplayed()
    await expect(byTestId('claude-question-status')).toHaveText('Respuesta enviada')
    await card.waitForDisplayed({ reverse: true, timeout: 4000 })
    await leaves(/alert|question/)
    await quitApp()

    // Ids, counts and results only: no question, option or answer text reaches the log.
    const log = readLogs()
    expect(log).toContain('Claude question answered')
    for (const text of [SINGLE.questions[0]!.question, 'SQLite', 'PostgreSQL', 'Base de datos', 'Relacional', 'e2e-unknown-key']) {
      expect(log).not.toContain(text)
    }
  })

  it('multiSelect joins the picked labels in option order and appends "Otro" last; ES/EN', async () => {
    const bridge = await start()

    const { reply } = await ask(bridge, 'facturacion-api', 'toolu_multi', MULTI)
    await expandTo('question')
    // Picked out of order: the answer still follows the options.
    await option(2).click()
    await option(0).click()
    await option(4).click()
    const other = byTestId('claude-question-other')
    await eventually(() => isFocused('[data-testid="claude-question-other"]'), (focused) => focused, 'the "Otro" field focused')
    expect(await sendButton().isEnabled()).toBe(false)
    await other.addValue(OTHER_TEXT)
    await sendButton().waitForEnabled()
    // The field says which question it answers.
    const describedBy = await other.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    await expect($(`[id="${describedBy}"]`)).toHaveText(MULTI.questions[0]!.question)
    await settle()

    await setLanguage('en')
    await expect(byTestId('claude-question')).toHaveText(expect.stringContaining('Claude asks'))
    await settle()
    await setLanguage('es')
    await expect(byTestId('claude-question')).toHaveText(expect.stringContaining('Claude te pregunta'))

    await inPage(() =>
      (globalThis as unknown as { document: { querySelector(s: string): { focus(): void } | null } }).document
        .querySelector('[data-testid="claude-question-other"]')
        ?.focus(),
    )
    await browser.keys(['Control', 'Enter'])
    const answer = await reply
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(answerBody(MULTI, { [MULTI.questions[0]!.question]: `Memoria del proceso, Cabeceras HTTP, ${OTHER_TEXT}` }))
    await byTestId('claude-question').waitForDisplayed({ reverse: true, timeout: 4000 })
    await quitApp()
    expect(readLogs()).not.toContain(OTHER_TEXT)
  })

  it('four questions, and "Otro" alone answers a single-choice question', async () => {
    const bridge = await start()

    const { reply } = await ask(bridge, 'tienda-pedidos', 'toolu_four', FOUR)
    await expandTo('question')
    await settle()

    // Option groups: 3+1, 4+1, 2+1, 2+1 items ("Otro…" last in each).
    await expect(options()).toBeElementsArrayOfSize(15)
    await option(0).click() // PostgreSQL
    await option(5).click() // Integración
    await option(6).click() // E2E
    await option(11).click() // Otro… (rama)
    await eventually(() => isFocused('[data-testid="claude-question-other"]'), (focused) => focused, 'the "Otro" field focused')
    await byTestId('claude-question-other').addValue('feat/pedidos')
    await option(13).click() // No, déjalo en local
    await expect($$('[data-testid="claude-question-other"]')).toBeElementsArrayOfSize(1)
    await sendButton().click()

    const answer = await reply
    expect(answer.body).toBe(
      answerBody(FOUR, {
        [FOUR.questions[0]!.question]: 'PostgreSQL',
        [FOUR.questions[1]!.question]: 'Integración, E2E',
        [FOUR.questions[2]!.question]: 'feat/pedidos',
        [FOUR.questions[3]!.question]: 'No, déjalo en local',
      }),
    )
  })

  it('keyboard: Enter never sends, Ctrl+Enter needs a complete form and sends once, Esc keeps it pending', async () => {
    const bridge = await start()

    const { reply } = await ask(bridge, 'pedidos', 'toolu_keys', TWO)
    await expandTo('question')
    // Initial focus: the first option of the first question. Space picks it.
    await eventually(() => optionFocused(0), (focused) => focused, 'the first option focused')
    await browser.keys('Space')
    await expect(option(0)).toHaveAttribute('aria-checked', 'true')

    // Enter on an option (and Ctrl+Enter) with the second question unanswered: nothing is sent.
    await browser.keys('Enter')
    await browser.keys(['Control', 'Enter'])
    expect(await settledWithin(reply, 700)).toBe('pending')
    await expect(capsule()).toHaveAttribute('data-mode', 'question')

    // Tab to the second question, Down + Space picks its second option.
    await browser.keys('Tab')
    await eventually(() => optionFocused(3), (focused) => focused, 'the second question focused')
    await browser.keys('ArrowDown')
    await browser.keys('Space')
    await expect(option(4)).toHaveAttribute('aria-checked', 'true')
    await sendButton().waitForEnabled()

    // Enter on a focused option still never sends, even with the form complete.
    await browser.keys('Enter')
    expect(await settledWithin(reply, 700)).toBe('pending')

    // Esc closes without answering: the question stays pending and the alert comes back.
    await browser.keys('Escape')
    await expect(capsule()).toHaveAttribute('data-mode', 'alert')
    expect(await settledWithin(reply, 500)).toBe('pending')

    // Reopened: a fresh form. Two quick Ctrl+Enter send once.
    await expandTo('question')
    await option(1).click()
    await option(3).click()
    await browser.keys(['Control', 'Enter'])
    await browser.keys(['Control', 'Enter'])
    const answer = await reply
    expect(answer.body).toBe(answerBody(TWO, { [TWO.questions[0]!.question]: 'orders-v2', [TWO.questions[1]!.question]: 'Sí, abre un PR' }))
    await byTestId('claude-question').waitForDisplayed({ reverse: true, timeout: 4000 })
    await quitApp()
    expect(readLogs().match(/Claude question answered/g) ?? []).toHaveLength(1)
  })

  it('"Responder en Claude" hands the question back with {}', async () => {
    const bridge = await start()

    const { reply } = await ask(bridge, 'pedidos', 'toolu_reply', SINGLE)
    await expandTo('question')
    await byTestId('claude-question-reply').click()
    expect(await reply).toEqual({ status: 200, body: NO_DECISION })
    await byTestId('claude-question').waitForDisplayed({ reverse: true })
    await leaves(/alert|question/)
  })

  it('a Stop of the session releases the question with {} and the card and alert go away', async () => {
    const bridge = await start()

    // Panel closed: the alert goes.
    const first = await ask(bridge, 'pedidos', 'toolu_stop1', SINGLE)
    expect((await postHook(bridge.hook, hookEvent('pedidos', 'Stop'))).status).toBe(200)
    expect(await first.reply).toEqual({ status: 200, body: NO_DECISION })
    await byTestId('claude-question-alert').waitForDisplayed({ reverse: true })
    await leaves(/^alert$/)

    // Panel open: the card says it is no longer pending, then closes.
    const second = await ask(bridge, 'pedidos', 'toolu_stop2', SINGLE)
    await expandTo('question')
    // A Stop of another session does not touch it.
    await postHook(bridge.hook, hookEvent('otra-sesion', 'Stop'))
    expect(await settledWithin(second.reply, 500)).toBe('pending')
    await postHook(bridge.hook, hookEvent('pedidos', 'Stop'))
    expect(await second.reply).toEqual({ status: 200, body: NO_DECISION })
    await byTestId('claude-question-gone').waitForDisplayed()
    await expect(byTestId('claude-question-status')).toHaveText('Esta pregunta ya no está pendiente')
    await byTestId('claude-question').waitForDisplayed({ reverse: true, timeout: 4000 })
    await leaves(/alert|question/)
  })

  it('permission first, then a question of another session: the permission opens first', async () => {
    const bridge = await start()

    const permission = postHook(bridge.hook, hookEvent('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }))
    await expect(capsule()).toHaveAttribute('data-mode', 'alert')
    const { reply } = await ask(bridge, 'pedidos', 'toolu_after', SINGLE)

    await expandTo('permission')
    const allow = byTestId('claude-allow')
    await allow.waitForEnabled({ timeout: 3000 })
    await allow.click()
    expect(await permission).toEqual({ status: 200, body: ALLOW_PERMISSION })

    // The panel moves on to the question.
    await expect(capsule()).toHaveAttribute('data-mode', 'question')
    await option(0).click()
    await sendButton().click()
    expect((await reply).body).toBe(answerBody(SINGLE, { [SINGLE.questions[0]!.question]: 'PostgreSQL' }))
    await byTestId('claude-question').waitForDisplayed({ reverse: true, timeout: 4000 })
    await leaves(/alert|question|permission/)
  })

  it('question first, then a permission of another session: the question opens first', async () => {
    const bridge = await start()

    const { reply } = await ask(bridge, 'pedidos', 'toolu_before', SINGLE)
    const permission = postHook(bridge.hook, hookEvent('api-server', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }))
    expect(await settledWithin(permission, 300)).toBe('pending')

    await expandTo('question')
    await option(2).click()
    await sendButton().click()
    expect((await reply).body).toBe(answerBody(SINGLE, { [SINGLE.questions[0]!.question]: 'MongoDB' }))
    await byTestId('claude-question-sent').waitForDisplayed()

    // After "Respuesta enviada", the panel moves on to the permission.
    await expect(capsule()).toHaveAttribute('data-mode', 'permission', { wait: 4000 })
    const deny = byTestId('claude-deny')
    await deny.waitForEnabled({ timeout: 3000 })
    await deny.click()
    expect(await permission).toEqual({ status: 200, body: DENY_PERMISSION })
    await leaves(/alert|question|permission/)
  })
})
