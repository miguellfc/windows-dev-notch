import { buildAnswers, type QuestionAnswer } from '../../../shared/claude/questions'
import type { ClaudeQuestion } from '../../../shared/claude/types'

/** What the user picked for one question so far: option positions and "Other…" with its text. */
export interface QuestionDraft {
  readonly selected: readonly number[]
  readonly otherOn: boolean
  readonly other: string
}

export const emptyDraft: QuestionDraft = Object.freeze({ selected: [], otherOn: false, other: '' })

/**
 * Picks an option. Single choice is a radio group with "Other…" as its last item: the option
 * replaces the previous pick and "Other…". multiSelect toggles it, keeping the display order.
 */
export function toggleOption(draft: QuestionDraft, multiSelect: boolean, index: number): QuestionDraft {
  if (!multiSelect) return { ...draft, selected: [index], otherOn: false }
  const selected = draft.selected.includes(index)
    ? draft.selected.filter((i) => i !== index)
    : [...draft.selected, index].sort((a, b) => a - b)
  return { ...draft, selected }
}

/** Picks "Other…": in single choice it replaces the option (and stays picked); in multiSelect it toggles. */
export function toggleOther(draft: QuestionDraft, multiSelect: boolean): QuestionDraft {
  if (!multiSelect) return { ...draft, selected: [], otherOn: true }
  return { ...draft, otherOn: !draft.otherOn }
}

export function withOtherText(draft: QuestionDraft, other: string): QuestionDraft {
  return { ...draft, other }
}

/** One question's answer; a picked "Other…" without text is not an answer yet. */
function draftAnswer(draft: QuestionDraft): QuestionAnswer | null {
  if (!draft.otherOn) return { selected: [...draft.selected] }
  const other = draft.other.trim()
  return other.length === 0 ? null : { selected: [...draft.selected], other }
}

/**
 * The `claude:answer` answers (positions and free text only), or null while the form is not
 * complete. Completeness uses the very rules main applies (`buildAnswers`), so Send is enabled
 * exactly when main would accept the answers.
 */
export function formAnswers(questions: readonly ClaudeQuestion[], drafts: readonly QuestionDraft[]): QuestionAnswer[] | null {
  if (drafts.length !== questions.length) return null
  const answers: QuestionAnswer[] = []
  for (const draft of drafts) {
    const answer = draftAnswer(draft)
    if (!answer) return null
    answers.push(answer)
  }
  return buildAnswers(questions, answers) ? answers : null
}

/**
 * Whether the alert capsule shows a question rather than a permission: permissions and questions are
 * one alert level, the earliest wins (both stamps come from the bridge's one clock).
 */
export function questionFirst(
  pending: readonly { receivedAt: number }[],
  questions: readonly { arrivedAt: number }[],
): boolean {
  if (questions.length === 0) return false
  if (pending.length === 0) return true
  return Math.min(...questions.map((q) => q.arrivedAt)) < Math.min(...pending.map((p) => p.receivedAt))
}
