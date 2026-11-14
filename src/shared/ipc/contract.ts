import { z } from 'zod'
import { appInfoSchema } from '../app-info'
import {
  clearInputSchema,
  codeReviewAlertSchema,
  codeReviewListSchema,
  codeReviewStateSchema,
  codeReviewViewInputSchema,
  contributionsChangedSchema,
  contributionsInputSchema,
  contributionsResultSchema,
  listInputSchema,
  openInputSchema,
  setTokenInputSchema,
  setTokenResultSchema,
} from '../code-review/schema'
import { QUESTION_LIMITS, questionAnswerInputSchema } from '../claude/questions'
import type { ClaudeRotateOutcome, ClaudeState, PendingQuestionView } from '../claude/types'
import {
  GMAIL_RECENT_LIMIT,
  gmailClientFileSchema,
  gmailIdInputSchema,
  gmailMessageDetailSchema,
  gmailMessageSchema,
  gmailNewMailSchema,
  gmailOpenInputSchema,
  gmailOpenLinkInputSchema,
  gmailStateSchema,
} from '../gmail/schema'
import { integrationIds } from '../integrations/registry'
import { createNoteInputSchema, noteIdInputSchema, noteSchema, pinNoteInputSchema, updateNoteInputSchema } from '../notes/schema'
import { createReminderInputSchema, reminderSchema, updateReminderInputSchema } from '../reminders/schema'
import { settingsPatchSchema, settingsSchema } from '../settings/schema'
import { killInputSchema, killResultSchema, PROCESS_LIMIT, processRowSchema, systemMetricsSchema, viewInputSchema } from '../system/schema'
import { usageSummaryInputSchema, usageSummarySchema } from '../usage/schema'
import type { ChannelName, EventName } from './channels'

interface ChannelContract {
  readonly input: z.ZodType
  readonly output: z.ZodType
}

export const notchModeSchema = z.enum(['compact', 'peek', 'alert', 'expanded', 'terminal', 'permission', 'question', 'reminders', 'system', 'notes', 'gmail', 'reviews', 'mini', 'hidden'])

/**
 * Control Center pages the notch may open directly (default page when omitted). A page id added
 * here must also exist in the Control Center's own page list.
 */
export const controlCenterPageSchema = z.enum(['gmail', 'code-review'])
export type ControlCenterPage = z.infer<typeof controlCenterPageSchema>

export const runtimeSchema = z.strictObject({
  isPackaged: z.boolean(),
  shortcutRegistered: z.boolean(),
})

/** Largest chunk the renderer may send in one terminal write; bigger pastes are split. */
export const TERMINAL_INPUT_MAX = 65_536

export const terminalOpenSchema = z.strictObject({
  state: z.enum(['running', 'exited']),
  exitCode: z.int().optional(),
  snapshot: z.string(),
  shell: z.string(),
})

export const claudeStateSchema = z.strictObject({
  connection: z.enum(['connected', 'waiting-for-events', 'not-installed', 'error']),
  reason: z.literal('port-in-use').optional(),
  hooks: z.enum(['installed', 'outdated', 'missing', 'unknown']),
  sessions: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      status: z.enum(['working', 'waiting', 'done', 'error', 'idle']),
      updatedAt: z.number(),
    }),
  ),
  pending: z.array(
    z.strictObject({
      id: z.string(),
      sessionId: z.string(),
      sessionName: z.string(),
      toolName: z.string(),
      preview: z.string(),
      previewTruncated: z.boolean(),
      previewLength: z.number(),
      receivedAt: z.number(),
    }),
  ),
}) satisfies z.ZodType<ClaudeState>

/** Pending AskUserQuestion calls as the notch sees them: no session id, display-safe texts. */
export const pendingQuestionsSchema = z.array(
  z.strictObject({
    id: z.string(),
    project: z.string(),
    questions: z
      .array(
        z.strictObject({
          question: z.string().max(QUESTION_LIMITS.question),
          header: z.string().max(QUESTION_LIMITS.header),
          multiSelect: z.boolean(),
          options: z
            .array(
              z.strictObject({
                label: z.string().max(QUESTION_LIMITS.label),
                description: z.string().max(QUESTION_LIMITS.description),
              }),
            )
            .min(QUESTION_LIMITS.minOptions)
            .max(QUESTION_LIMITS.maxOptions),
        }),
      )
      .min(QUESTION_LIMITS.minQuestions)
      .max(QUESTION_LIMITS.maxQuestions),
    arrivedAt: z.number(),
  }),
) satisfies z.ZodType<PendingQuestionView[]>

/** What a token or port rotation did to installed hooks (a failed reinstall is not a success). */
export const claudeRotateSchema = z.strictObject({
  hooks: z.enum(['reinstalled', 'not-installed', 'reinstall-failed']),
}) satisfies z.ZodType<ClaudeRotateOutcome>

const diffSchema = z.array(z.strictObject({ kind: z.enum(['add', 'remove', 'same']), text: z.string() }))
const invalidJsonSchema = z.strictObject({ ok: z.literal(false), reason: z.literal('invalid-json') })

/** Diff of Claude's settings.json with every bridge token masked. */
export const claudeHooksPreviewSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), diff: diffSchema }),
  invalidJsonSchema,
])

export const claudeHooksWriteSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), changed: z.boolean(), diff: diffSchema, backupFile: z.string().optional() }),
  invalidJsonSchema,
])

/** Full reminders list plus why it may be incomplete (corrupt file moved aside, or read-only session). */
export const remindersSnapshotSchema = z.strictObject({
  reminders: z.array(reminderSchema),
  notice: z.enum(['quarantined', 'read-only']).nullable(),
})

/** Full notes list (pinned first) plus why it may be incomplete (corrupt file moved aside, or read-only session). */
export const notesSnapshotSchema = z.strictObject({
  notes: z.array(noteSchema),
  notice: z.enum(['quarantined', 'read-only']).nullable(),
})

const reminderIdSchema = z.strictObject({ id: z.uuid() })

const none = z.undefined()
const ack = z.null()

/** Single source of truth for every IPC channel: what it accepts and what it returns. */
export const contract = {
  'app:get-info': { input: none, output: appInfoSchema },
  'app:get-runtime': { input: none, output: runtimeSchema },
  'app:open-control-center': { input: z.strictObject({ page: controlCenterPageSchema }).optional(), output: ack },
  'app:hide-notch': { input: none, output: ack },
  'settings:get': { input: none, output: settingsSchema },
  'settings:update': { input: settingsPatchSchema, output: settingsSchema },
  'notch:get-mode': { input: none, output: notchModeSchema },
  'notch:request': { input: z.strictObject({ intent: z.enum(['expand', 'dismiss', 'toggle', 'next', 'pin-mini', 'unpin-mini']) }), output: ack },
  'notch:pointer': { input: z.strictObject({ inside: z.boolean() }), output: ack },
  'notch:settled': { input: none, output: ack },
  'notch:open-integration': { input: z.strictObject({ id: z.enum(integrationIds) }), output: ack },
  'notch:back': { input: none, output: ack },
  'terminal:open': { input: none, output: terminalOpenSchema },
  'terminal:input': { input: z.strictObject({ data: z.string().min(1).max(TERMINAL_INPUT_MAX) }), output: ack },
  'terminal:resize': {
    input: z.strictObject({ cols: z.int().min(2).max(500), rows: z.int().min(1).max(200) }),
    output: ack,
  },
  'claude:get-state': { input: none, output: claudeStateSchema },
  'claude:decide': {
    input: z.strictObject({ requestId: z.uuid(), decision: z.enum(['allow', 'deny']) }),
    output: ack,
  },
  'claude:focus-app': { input: none, output: ack },
  'claude:dismiss-session': { input: z.strictObject({ sessionId: z.string().min(1).max(256) }), output: ack },
  'claude:hooks-preview': { input: none, output: claudeHooksPreviewSchema },
  'claude:hooks-install': { input: none, output: claudeHooksWriteSchema },
  'claude:hooks-uninstall': { input: none, output: claudeHooksWriteSchema },
  'claude:test-connection': { input: none, output: z.strictObject({ ok: z.boolean() }) },
  'claude:rotate-token': { input: none, output: claudeRotateSchema },
  'claude:rotate-port': { input: none, output: claudeRotateSchema },
  'claude:get-questions': { input: none, output: pendingQuestionsSchema },
  /** Positions and free text only: main builds Claude's `answers` from the questions it received. */
  'claude:answer': { input: questionAnswerInputSchema, output: z.enum(['sent', 'gone']) },
  /** Gives the question back to Claude's own dialog and brings Claude forward. */
  'claude:release-question': { input: z.strictObject({ id: z.string().min(1).max(256) }), output: ack },
  'reminders:list': { input: none, output: remindersSnapshotSchema },
  'reminders:create': { input: createReminderInputSchema, output: reminderSchema },
  'reminders:update': { input: updateReminderInputSchema, output: reminderSchema },
  'reminders:snooze': { input: reminderIdSchema, output: reminderSchema },
  'reminders:complete': { input: reminderIdSchema, output: reminderSchema },
  'reminders:delete': { input: reminderIdSchema, output: ack },
  'notes:list': { input: none, output: notesSnapshotSchema },
  'notes:create': { input: createNoteInputSchema, output: noteSchema },
  'notes:update': { input: updateNoteInputSchema, output: noteSchema },
  'notes:pin': { input: pinNoteInputSchema, output: noteSchema },
  'notes:delete': { input: noteIdInputSchema, output: noteSchema },
  'notes:restore': { input: noteIdInputSchema, output: noteSchema },
  'notes:copy': { input: noteIdInputSchema, output: ack },
  'usage:summary': { input: usageSummaryInputSchema, output: usageSummarySchema },
  'system:view': { input: viewInputSchema, output: ack },
  'system:kill-process': { input: killInputSchema, output: killResultSchema },
  'gmail:get-state': { input: none, output: gmailStateSchema },
  'gmail:recent': { input: none, output: z.array(gmailMessageSchema).max(GMAIL_RECENT_LIMIT) },
  'gmail:view': { input: z.strictObject({ open: z.boolean() }), output: ack },
  'gmail:refresh': { input: none, output: ack },
  /** Main builds the URL from a shown id (last list, open message, last alert); the renderer never sends one. */
  'gmail:open': { input: gmailOpenInputSchema, output: ack },
  'gmail:sign-in': { input: none, output: z.enum(['ok', 'cancelled', 'error']) },
  'gmail:cancel-sign-in': { input: none, output: ack },
  'gmail:sign-out': { input: none, output: ack },
  /** Main shows the native file dialog and parses Google's client JSON; the secret never touches the log. */
  'gmail:pick-client-file': { input: none, output: gmailClientFileSchema.nullable() },
  /** Plain text of a message main showed to the notch (never HTML). */
  'gmail:message': { input: gmailIdInputSchema, output: gmailMessageDetailSchema },
  'gmail:mark-read': { input: gmailIdInputSchema, output: ack },
  /** Permanent: main only deletes ids it showed; the notch confirms first. */
  'gmail:delete': { input: gmailIdInputSchema, output: ack },
  /** Opens link `index` of the open message; the renderer never sends a URL. */
  'gmail:open-link': { input: gmailOpenLinkInputSchema, output: ack },
  /** The reader closed: main forgets the open message (body and links); list ids stay shown. */
  'gmail:close-message': { input: none, output: ack },
  'code-review:get-state': { input: none, output: codeReviewStateSchema },
  /** Lists of one platform without URLs (main keeps them); remembered as the ids `open` accepts. */
  'code-review:list': { input: listInputSchema, output: codeReviewListSchema },
  'code-review:refresh': { input: none, output: ack },
  /** Main opens the URL of an id from the last list, on github.com or the configured GitLab origin only. */
  'code-review:open': { input: openInputSchema, output: ack },
  /** Validates the token against the API before saving; the token never comes back. */
  'code-review:set-token': { input: setTokenInputSchema, output: setTokenResultSchema },
  'code-review:clear': { input: clearInputSchema, output: ack },
  /** The "Revisiones" view opened or closed: contributions are queried only while it is open. */
  'code-review:view': { input: codeReviewViewInputSchema, output: ack },
  /** The cached month summary of a platform (null when unconfigured or not loaded yet) and the last query's error flag; never repositories. */
  'code-review:contributions': { input: contributionsInputSchema, output: contributionsResultSchema },
} as const satisfies Record<ChannelName, ChannelContract>

/** Payloads of the events the main process pushes to renderers. */
export const eventContract = {
  'notch:mode-changed': notchModeSchema,
  /** Whether the alert capsule shows the new-mail alert (not a permission or a reminder); sent before the mode. */
  'notch:mail-alert': z.boolean(),
  /** Whether the alert capsule shows the first-review alert; sent before the mode, like `notch:mail-alert`. */
  'notch:review-alert': z.boolean(),
  'settings:changed': settingsSchema,
  'terminal:data': z.string(),
  'terminal:exit': z.strictObject({ exitCode: z.int() }),
  'claude:state-changed': claudeStateSchema,
  /** Pending questions, to the notch only (the Control Center never gets Claude's question texts). */
  'claude:questions': pendingQuestionsSchema,
  'reminders:changed': remindersSnapshotSchema,
  /** A new batch is due (or reminders were missed at startup): the notch plays the chime. */
  'reminders:fired': z.strictObject({ count: z.int().positive() }),
  'notes:changed': notesSnapshotSchema,
  'system:metrics': systemMetricsSchema,
  /** Top processes of the System view (at most PROCESS_LIMIT). */
  'system:processes': z.array(processRowSchema).max(PROCESS_LIMIT),
  /** Gmail session and unread count, to the notch and the Control Center (never tokens or mail). */
  'gmail:state': gmailStateSchema,
  /** New unread mail, to the notch only; no sender or subject when the user hides them. */
  'gmail:new-mail': gmailNewMailSchema,
  /** GitHub/GitLab status, account and unreviewed counts, to the notch and the Control Center (never tokens). */
  'code-review:state': codeReviewStateSchema,
  /** Own PR/MRs got their first review, to the notch only; `kind`/`ref`/`title` for a single one. */
  'code-review:alert': codeReviewAlertSchema,
  /** A platform's contributions changed or a query ended (with its error flag), to the notch only. */
  'code-review:contributions-changed': contributionsChangedSchema,
} as const satisfies Record<EventName, z.ZodType>

export type Contract = typeof contract
export type ContractInput<C extends ChannelName> = z.output<Contract[C]['input']>
export type ContractOutput<C extends ChannelName> = z.output<Contract[C]['output']>
export type EventPayload<E extends EventName> = z.output<(typeof eventContract)[E]>
