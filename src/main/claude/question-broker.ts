import type { HookEvent, HookEventName } from '../../shared/claude/hook-events'
import {
  buildAnswers,
  questionResponseBody,
  type AskQuestion,
  type AskUserQuestionRawInput,
  type QuestionAnswer,
} from '../../shared/claude/questions'
import type { PendingQuestion } from '../../shared/claude/types'
import type { PendingReply } from './permission-broker'

export type QuestionBrokerOptions = {
  newId: () => string
  now: () => number
  /** Display name of a session; `cwd` names one this app has not seen yet. */
  sessionName: (id: string, cwd?: string) => string
  onChange: () => void
}

export type AnswerResult = 'sent' | 'gone' | 'invalid'

export type QuestionBroker = {
  hold(e: HookEvent, reply: PendingReply): void
  answer(id: string, answers: readonly QuestionAnswer[]): AnswerResult
  release(id: string): boolean
  observe(e: HookEvent): void
  releaseAll(): void
  pending(): PendingQuestion[]
}

type Entry = {
  info: PendingQuestion
  reply: PendingReply
  toolUseId: string | undefined
  /** Claude's tool_input as received: echoed back untouched in the answer. Never logged. */
  rawInput: AskUserQuestionRawInput
}

/** Claude treats an empty object as "no decision" and shows its own question dialog. */
const NO_DECISION = '{}'

// The AskUserQuestion call is over (answered in Claude's window, or failed).
const TOOL_END_EVENTS: ReadonlySet<HookEventName> = new Set(['PostToolUse', 'PostToolUseFailure'])
// The turn is over (or was interrupted): nothing of the session can still be waiting on us.
const SESSION_END_EVENTS: ReadonlySet<HookEventName> = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd'])

/** A send that throws (socket already gone) must not stop the bookkeeping or the other releases. */
const safeSend = (reply: PendingReply, body: string): boolean => {
  try {
    reply.send(body)
    return true
  } catch {
    // The request is over either way.
    return false
  }
}

const copyQuestions = (questions: readonly AskQuestion[]): AskQuestion[] =>
  questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) }))

/**
 * Holds Claude's AskUserQuestion hook requests until the user answers them in the notch, releases them
 * (`{}`: Claude asks in its own window) or they stop being pending. Never logs question or answer texts.
 */
export const createQuestionBroker = (options: QuestionBrokerOptions): QuestionBroker => {
  // Map keeps insertion (arrival) order.
  const entries = new Map<string, Entry>()

  // Removing before sending makes a later onClose for the same reply a no-op. False when the send failed.
  const settle = (id: string, body: string): boolean => {
    const entry = entries.get(id)
    if (!entry) return false
    entries.delete(id)
    const sent = safeSend(entry.reply, body)
    options.onChange()
    return sent
  }

  const releaseWhere = (match: (entry: Entry) => boolean): void => {
    for (const [id, entry] of [...entries]) if (match(entry)) settle(id, NO_DECISION)
  }

  return {
    hold(e, reply) {
      if (e.name !== 'PreToolUse' || !e.askUserQuestion) {
        safeSend(reply, NO_DECISION)
        return
      }
      const id = options.newId()
      entries.set(id, {
        info: {
          id,
          sessionId: e.sessionId,
          project: options.sessionName(e.sessionId, e.cwd),
          questions: copyQuestions(e.askUserQuestion.questions),
          arrivedAt: reply.arrivedAt ?? options.now(),
        },
        reply,
        toolUseId: e.toolUseId,
        rawInput: e.askUserQuestionRaw ?? e.askUserQuestion,
      })
      reply.onClose(() => {
        if (entries.delete(id)) options.onChange()
      })
      options.onChange()
    },

    answer(id, answers) {
      const entry = entries.get(id)
      if (!entry) return 'gone'
      const built = buildAnswers(entry.info.questions, answers)
      if (built === null) return 'invalid'
      return settle(id, questionResponseBody(entry.rawInput, built)) ? 'sent' : 'gone'
    },

    release(id) {
      if (!entries.has(id)) return false
      settle(id, NO_DECISION)
      return true
    },

    observe(e) {
      if (SESSION_END_EVENTS.has(e.name)) {
        releaseWhere((entry) => entry.info.sessionId === e.sessionId)
      } else if (TOOL_END_EVENTS.has(e.name) && e.toolUseId !== undefined) {
        releaseWhere((entry) => entry.info.sessionId === e.sessionId && entry.toolUseId === e.toolUseId)
      }
      // PreToolUse, PermissionRequest, PermissionDenied, Notification, Subagent*: never release.
    },

    releaseAll() {
      for (const id of [...entries.keys()]) settle(id, NO_DECISION)
    },

    pending() {
      return [...entries.values()].map((entry) => ({ ...entry.info, questions: copyQuestions(entry.info.questions) }))
    },
  }
}
