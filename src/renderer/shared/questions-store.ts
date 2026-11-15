import { create } from 'zustand'
import type { PendingQuestionView } from '../../shared/claude/types'

interface QuestionsStoreState {
  /** Pending Claude questions, oldest first; null until the first list arrives. Notch only. */
  questions: PendingQuestionView[] | null
}

export const useQuestions = create<QuestionsStoreState>(() => ({ questions: null }))

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindQuestions(): void {
  let pushed = false
  window.notch.events.on('claude:questions', (questions) => {
    pushed = true
    useQuestions.setState({ questions })
  })
  void window.notch.claude.getQuestions().then((result) => {
    if (result.ok && !pushed) useQuestions.setState({ questions: result.data })
  })
}
