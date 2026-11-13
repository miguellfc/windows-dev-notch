import type { HookEvent } from '../../shared/claude/hook-events'
import { displayQuestions, type QuestionAnswer } from '../../shared/claude/questions'
import type {
  ClaudeConnectionErrorReason,
  ClaudeHooksStatus,
  ClaudeRotateOutcome,
  ClaudeState,
  PendingPermission,
  PendingQuestionView,
} from '../../shared/claude/types'
import { ExposedIpcError } from '../ipc/errors'
import type { Logger } from '../services/logger'
import type { BridgeConfig } from './bridge-config'
import type { ClaudeBridge, ClaudeBridgeOptions, HookRoute } from './claude-bridge'
import type { DiffLine, HookInstaller, InvalidJson } from './hook-installer'
import { createPermissionBroker, type PendingReply } from './permission-broker'
import { createQuestionBroker, type AnswerResult } from './question-broker'
import { createSessionRegistry } from './session-registry'

/** Session id used by "test connection"; its events never become a session. */
export const CONNECTION_TEST_SESSION_ID = 'developer-notch-connection-test'

const TEST_TIMEOUT_MS = 3_000
const TOKEN_HEADER = 'x-notch-token'
const MASK = '••••••'
const TOKEN_FIELD = /("x-notch-token"\s*:\s*")[^"]*(")/g

export type ClaudeBridgeFactory = (options: Omit<ClaudeBridgeOptions, 'logger'>) => ClaudeBridge

export type ClaudeServiceDeps = {
  logger: Logger
  now: () => number
  newId: () => string
  /** False when the OS cannot protect the token (safeStorage); the bridge then never starts. */
  encryptionAvailable: () => boolean
  loadConfig: () => Promise<BridgeConfig>
  rotateConfig: () => Promise<BridgeConfig>
  /** Persists a new random port (same token). */
  rotatePortConfig: () => Promise<BridgeConfig>
  createBridge: ClaudeBridgeFactory
  installer: HookInstaller
  focusClaude: () => void
  /** Called after every state change. */
  onState: (state: ClaudeState) => void
  /** Called once per permission request when it starts waiting. */
  onNewPending: (permission: PendingPermission) => void
  /** Called whenever the pending questions change (display-safe views, never the session id). */
  onQuestions: (questions: PendingQuestionView[]) => void
  /** Called once per question when it starts waiting, after `onQuestions` listed it. */
  onNewQuestion: (question: PendingQuestionView) => void
  /** Dev/test only: listen here instead of the stored port (0 = ephemeral); hooks are written with the real one. */
  portOverride?: number
  fetch?: typeof fetch
  idleAfterMs?: number
}

export type HooksPreview = { ok: true; diff: DiffLine[] } | InvalidJson
export type HooksWriteOutcome = { ok: true; changed: boolean; diff: DiffLine[]; backupFile?: string } | InvalidJson

export type ClaudeService = {
  start(): Promise<void>
  /** Releases every held request without a decision, then stops the bridge. */
  stop(): Promise<void>
  /** Periodic housekeeping: idle sessions and hooks edited outside the app. */
  tick(): Promise<void>
  state(): ClaudeState
  decide(id: string, decision: 'allow' | 'deny'): boolean
  /** Pending AskUserQuestion calls, oldest first, as the notch may see them. */
  questions(): PendingQuestionView[]
  /** Answers a question from option positions and free text; main builds the texts sent to Claude. */
  answer(id: string, answers: readonly QuestionAnswer[]): AnswerResult
  /** Gives the question back to Claude's own dialog (if still pending) and brings Claude forward. */
  releaseQuestion(id: string): void
  dismissSession(id: string): boolean
  focusApp(): void
  previewHooks(): Promise<HooksPreview>
  installHooks(): Promise<HooksWriteOutcome>
  uninstallHooks(): Promise<HooksWriteOutcome>
  testConnection(): Promise<{ ok: boolean }>
  /** Resolves with what happened to installed hooks, so a failed reinstall is never reported as success. */
  rotateToken(): Promise<ClaudeRotateOutcome>
  /** Moves the bridge to a new random port (e.g. ours is taken), reinstalling installed hooks. */
  rotatePort(): Promise<ClaudeRotateOutcome>
}

export const createClaudeService = (deps: ClaudeServiceDeps): ClaudeService => {
  const log = deps.logger.child('claude')
  const doFetch = deps.fetch ?? globalThis.fetch
  const registry = createSessionRegistry({ now: deps.now, ...(deps.idleAfterMs ? { idleAfterMs: deps.idleAfterMs } : {}) })

  let config: BridgeConfig | null = null
  let bridge: ClaudeBridge | null = null
  let bridgeRunning = false
  let bridgeError: ClaudeConnectionErrorReason | null = null
  let hooks: ClaudeHooksStatus = 'unknown'
  let eventSeen = false
  let inEvent = false
  /** Session ids with a pending request, as of the last broker change. */
  let pendingSessions = new Set<string>()
  const announced = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()

  const state = (): ClaudeState => {
    let connection: ClaudeState['connection']
    if (!config || !bridgeRunning) connection = 'error'
    else if (hooks === 'missing') connection = 'not-installed'
    else connection = eventSeen ? 'connected' : 'waiting-for-events'
    const reason = connection === 'error' && bridgeError ? { reason: bridgeError } : {}
    return { connection, ...reason, hooks, sessions: registry.sessions(), pending: broker.pending() }
  }

  const publish = (): void => {
    const current = state()
    const ids = new Set(current.pending.map((p) => p.id))
    for (const id of announced) if (!ids.has(id)) announced.delete(id)
    deps.onState(current)
    for (const permission of current.pending) {
      if (announced.has(permission.id)) continue
      announced.add(permission.id)
      deps.onNewPending(permission)
    }
  }

  /**
   * A session with a held permission or question is `waiting` (even after a later event of it, such as
   * the /hook copy of a held AskUserQuestion, said `working`); one whose last held request went away
   * leaves `waiting`. `first` names a session first seen through the request being held.
   */
  const syncWaiting = (first?: { sessionId: string; cwd?: string | undefined }): void => {
    const now = heldSessions()
    for (const id of pendingSessions) if (!now.has(id)) registry.resolveWaiting(id)
    for (const id of now) registry.markWaiting(id, first?.sessionId === id ? first.cwd : undefined)
    pendingSessions = now
  }

  /** Outside a hook event, a broker change is synced and published at once; onEvent does it at its end. */
  const brokerChanged = (): void => {
    if (inEvent) return
    syncWaiting()
    publish()
    publishQuestions()
  }

  const broker = createPermissionBroker({
    newId: deps.newId,
    now: deps.now,
    sessionName: (id) => registry.nameOf(id),
    onChange: brokerChanged,
  })

  /** The question list changed since it was last sent. */
  let questionsDirty = false
  const announcedQuestions = new Set<string>()

  const questionViews = (): PendingQuestionView[] =>
    questionBroker.pending().map(({ id, project, questions, arrivedAt }) => ({
      id,
      project,
      questions: displayQuestions(questions),
      arrivedAt,
    }))

  const publishQuestions = (): void => {
    if (!questionsDirty) return
    questionsDirty = false
    const current = questionViews()
    const ids = new Set(current.map((q) => q.id))
    for (const id of announcedQuestions) if (!ids.has(id)) announcedQuestions.delete(id)
    deps.onQuestions(current)
    for (const question of current) {
      if (announcedQuestions.has(question.id)) continue
      announcedQuestions.add(question.id)
      deps.onNewQuestion(question)
    }
  }

  const questionBroker = createQuestionBroker({
    newId: deps.newId,
    now: deps.now,
    sessionName: (id, cwd) => registry.nameOf(id, cwd),
    onChange: () => {
      questionsDirty = true
      brokerChanged()
    },
  })

  /** Sessions with something held for the user: they never go idle meanwhile. */
  const heldSessions = (): Set<string> =>
    new Set([...broker.pending().map((p) => p.sessionId), ...questionBroker.pending().map((q) => q.sessionId)])

  let testProbeSeen = false

  const onEvent = (e: HookEvent, reply: PendingReply | null, route: HookRoute = 'hook'): void => {
    if (e.sessionId === CONNECTION_TEST_SESSION_ID) {
      testProbeSeen = true
      reply?.send(null)
      return
    }
    // The question route only matters for the AskUserQuestion call it holds: Claude sends the same call
    // to /hook too, where it is observed like every other event (so nothing is counted twice).
    if (route === 'question' && reply === null) return
    inEvent = true
    try {
      eventSeen = true
      if (route === 'question') {
        if (reply !== null) questionBroker.hold(e, reply)
      } else {
        registry.apply(e)
        questionBroker.observe(e)
        const held = e.name === 'PermissionRequest' && reply !== null
        // observe first: nothing that arrived before this request may release it.
        if (!held) broker.observe(e)
        else broker.hold(e, reply)
      }
      // After the brokers: a Stop that released the session's requests leaves it `done`, not waiting.
      syncWaiting({ sessionId: e.sessionId, cwd: e.cwd })
    } finally {
      inEvent = false
    }
    publish()
    publishQuestions()
  }

  const refreshHooks = async (): Promise<boolean> => {
    let next: ClaudeHooksStatus = 'unknown'
    if (config) {
      try {
        next = await deps.installer.status(config)
      } catch (error) {
        log.warn('Could not read Claude settings', { error })
      }
    }
    const changed = next !== hooks
    hooks = next
    return changed
  }

  const startBridge = async (current: BridgeConfig): Promise<void> => {
    bridge = deps.createBridge({ port: deps.portOverride ?? current.port, token: current.token, onEvent })
    try {
      await bridge.start()
      bridgeRunning = true
      bridgeError = null
      if (deps.portOverride !== undefined) config = { ...current, port: bridge.port() }
    } catch (error) {
      bridgeRunning = false
      const code = (error as NodeJS.ErrnoException).code
      bridgeError = code === 'EADDRINUSE' ? 'port-in-use' : null
      log.warn('Claude bridge could not start', { port: current.port, code })
    }
  }

  const stopBridge = async (): Promise<void> => {
    broker.releaseAll()
    questionBroker.releaseAll()
    const current = bridge
    bridge = null
    bridgeRunning = false
    await current?.stop()
  }

  /** Control Center operations touch the same files; run them one at a time. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  const requireConfig = (): BridgeConfig => {
    if (!config) throw new ExposedIpcError('UNAVAILABLE', 'Claude bridge is not available')
    return config
  }

/** Replaces the bridge config (token or port), restarts the bridge and reinstalls hooks that were installed. */
  const rotate = (next: () => Promise<BridgeConfig>, what: 'token' | 'port'): Promise<ClaudeRotateOutcome> =>
    serial(async () => {
      requireConfig()
      const reinstall = hooks === 'installed' || hooks === 'outdated'
      const rotated = await next()
      await stopBridge()
      config = rotated
      await startBridge(rotated)
      let outcome: ClaudeRotateOutcome['hooks'] = 'not-installed'
      if (reinstall) {
        try {
          const result = await deps.installer.install(config ?? rotated)
          outcome = result.ok ? 'reinstalled' : 'reinstall-failed'
          if (!result.ok) log.warn(`Could not reinstall Claude hooks after rotating the ${what}`, { reason: result.reason })
        } catch (error) {
          outcome = 'reinstall-failed'
          log.warn(`Could not reinstall Claude hooks after rotating the ${what}`, { error })
        }
      }
      await refreshHooks()
      publish()
      return { hooks: outcome }
    })

  const mask = (lines: DiffLine[]): DiffLine[] =>
    lines.map(({ kind, text }) => {
      let masked = text.replace(TOKEN_FIELD, `$1${MASK}$2`)
      if (config) masked = masked.replaceAll(config.token, MASK)
      return { kind, text: masked }
    })

  return {
    start: async () => {
      if (!deps.encryptionAvailable()) {
        log.warn('Encryption is unavailable; the Claude bridge stays off')
      } else {
        try {
          config = await deps.loadConfig()
        } catch (error) {
          log.error('Could not load the Claude bridge config', { error })
        }
        if (config) await startBridge(config)
      }
      await refreshHooks()
      publish()
    },

    stop: () => stopBridge(),

    tick: async () => {
      const idleChanged = registry.tick(heldSessions())
      const hooksChanged = await refreshHooks()
      if (idleChanged || hooksChanged) publish()
    },

    state,

    decide: (id, decision) => broker.decide(id, decision),

    questions: questionViews,

    answer: (id, answers) => {
      const result = questionBroker.answer(id, answers)
      // Ids and results only: question, option and answer texts never reach the log.
      log.info('Claude question answered', { id, result, count: answers.length })
      return result
    },

    releaseQuestion: (id) => {
      const released = questionBroker.release(id)
      log.info('Claude question handed back to Claude', { id, released })
      deps.focusClaude()
    },

    dismissSession: (id) => {
      const removed = registry.dismiss(id)
      if (removed) publish()
      return removed
    },

    focusApp: () => deps.focusClaude(),

    previewHooks: () =>
      serial(async () => {
        const plan = await deps.installer.preview(requireConfig())
        return plan.ok ? { ok: true, diff: mask(plan.diff) } : plan
      }),

    installHooks: () =>
      serial(async () => {
        const result = await deps.installer.install(requireConfig())
        await refreshHooks()
        publish()
        return result.ok ? { ...result, diff: mask(result.diff) } : result
      }),

    uninstallHooks: () =>
      serial(async () => {
        const result = await deps.installer.uninstall()
        await refreshHooks()
        publish()
        return result.ok ? { ...result, diff: mask(result.diff) } : result
      }),

    testConnection: async () => {
      if (!config || !bridge || !bridgeRunning) return { ok: false }
      testProbeSeen = false
      try {
        const response = await doFetch(`http://127.0.0.1:${bridge.port()}/hook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [TOKEN_HEADER]: config.token },
          body: JSON.stringify({
            session_id: CONNECTION_TEST_SESSION_ID,
            hook_event_name: 'Notification',
            notification_type: 'connection_test',
          }),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        })
        await response.arrayBuffer()
        return { ok: response.status === 200 && testProbeSeen }
      } catch {
        return { ok: false }
      }
    },

    rotateToken: () => rotate(deps.rotateConfig, 'token'),

    rotatePort: () => rotate(deps.rotatePortConfig, 'port'),
  }
}
