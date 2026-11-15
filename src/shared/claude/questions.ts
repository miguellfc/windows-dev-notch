import { z } from 'zod'
import type { ClaudeQuestion } from './types'

export type AskQuestion = ClaudeQuestion

export const QUESTION_LIMITS = {
  minQuestions: 1,
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 4,
  question: 500,
  header: 60,
  label: 120,
  description: 300,
  other: 500,
} as const

const optionSchema = z.object({
  label: z.string().min(1).max(QUESTION_LIMITS.label),
  description: z.string().max(QUESTION_LIMITS.description),
})

const questionSchema = z.object({
  question: z.string().min(1).max(QUESTION_LIMITS.question),
  header: z.string().max(QUESTION_LIMITS.header),
  multiSelect: z.boolean(),
  options: z.array(optionSchema).min(QUESTION_LIMITS.minOptions).max(QUESTION_LIMITS.maxOptions),
})

/**
 * Validated view of `tool_input` of Claude's `AskUserQuestion` (for the UI and `buildAnswers`). Unknown keys
 * are dropped from this view only; the raw `tool_input` is what goes back to Claude. Question texts must be
 * unique because `answers` is keyed by them. Texts are kept exactly as received.
 */
export const askUserQuestionInputSchema = z
  .object({
    questions: z.array(questionSchema).min(QUESTION_LIMITS.minQuestions).max(QUESTION_LIMITS.maxQuestions),
  })
  .refine((input) => new Set(input.questions.map((q) => q.question)).size === input.questions.length, {
    message: 'Question texts must be unique',
  })

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>

/** The `tool_input` exactly as Claude sent it (already validated by `askUserQuestionInputSchema`). Never logged. */
export type AskUserQuestionRawInput = Readonly<Record<string, unknown>>

/** One answer per question, in order: option positions and an optional free text ("Other"). */
export type QuestionAnswer = { selected: number[]; other?: string | undefined }

/** Shape-only check of `claude:answer`; the rules that depend on the questions live in `buildAnswers`. */
export const questionAnswerInputSchema = z.strictObject({
  id: z.string().min(1).max(256),
  answers: z
    .array(
      z.strictObject({
        selected: z.array(z.number().int().nonnegative()).max(QUESTION_LIMITS.maxOptions),
        other: z.string().max(QUESTION_LIMITS.other * 4).optional(),
      }),
    )
    .min(QUESTION_LIMITS.minQuestions)
    .max(QUESTION_LIMITS.maxQuestions),
})

// \n, \r, U+2028 and U+2029 (the latter built from code points: they are line terminators in source).
const LINE_BREAK = new RegExp(`[\n\r${String.fromCharCode(0x2028, 0x2029)}]`)

const freeText = (other: string | undefined): string | null | undefined => {
  if (other === undefined) return undefined
  const text = other.trim()
  if (text.length < 1 || text.length > QUESTION_LIMITS.other || LINE_BREAK.test(text)) return null
  return text
}

const validSelection = (selected: readonly number[], optionCount: number): boolean =>
  selected.every((i) => Number.isInteger(i) && i >= 0 && i < optionCount) && new Set(selected).size === selected.length

/**
 * Claude's `answers` map (question text → answer), built only from the questions main received.
 * Single choice: exactly one option or a free text. multiSelect: labels joined by ", " with the free
 * text last (commas inside labels or the free text are not escaped; Claude takes the text as is).
 * Returns null when the answers break any rule.
 */
export const buildAnswers = (
  questions: readonly AskQuestion[],
  answers: readonly QuestionAnswer[],
): Record<string, string> | null => {
  if (answers.length !== questions.length) return null
  const out: Record<string, string> = {}
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]!
    if (!validSelection(answer.selected, question.options.length)) return null
    const other = freeText(answer.other)
    if (other === null) return null
    // In the order the options are shown, whatever order they were picked in.
    const labels = [...answer.selected].sort((a, b) => a - b).map((i) => question.options[i]!.label)
    if (question.multiSelect) {
      if (labels.length === 0 && other === undefined) return null
    } else if (labels.length + (other === undefined ? 0 : 1) !== 1) {
      return null
    }
    out[question.question] = [...labels, ...(other === undefined ? [] : [other])].join(', ')
  }
  return out
}

/**
 * The hook response that answers the questions: allow, with Claude's original `tool_input` untouched
 * (unknown keys included) plus `answers`.
 */
export const questionResponseBody = (rawInput: AskUserQuestionRawInput, answers: Record<string, string>): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...rawInput, answers },
    },
  })

// C0/C1 controls except \t and \n (\r is turned into a line break first).
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// Unicode format characters: bidi embeddings/overrides (U+202A–202E) and isolates (U+2066–2069), zero-width, BOM...
const FORMAT_CHARS = /\p{Cf}/gu
// CRLF, CR, U+2028 and U+2029 become \n (the last two built from code points: they are line terminators in source).
const LINE_BREAKS = new RegExp(`\\r\\n?|[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/** Display-only copy of a Claude text: no controls or format characters. Never apply it to what goes back to Claude. */
export const displayText = (text: string): string =>
  text.replace(LINE_BREAKS, '\n').replace(CONTROL_CHARS, '').replace(FORMAT_CHARS, '')

const displayLine = (text: string): string => displayText(text).replace(/[\n\t]+/g, ' ')

/** Display-only copy of the questions (headers and labels on one line). The input is not modified. */
export const displayQuestions = (questions: readonly AskQuestion[]): AskQuestion[] =>
  questions.map((q) => ({
    question: displayText(q.question),
    header: displayLine(q.header),
    multiSelect: q.multiSelect,
    options: q.options.map((o) => ({ label: displayLine(o.label), description: displayText(o.description) })),
  }))

