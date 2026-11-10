import { create } from 'zustand'
import type { ClaudeState } from '../../shared/claude/types'

interface ClaudeStoreState {
  /** Null until the first state arrives. */
  state: ClaudeState | null
}

export const useClaude = create<ClaudeStoreState>(() => ({ state: null }))

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindClaude(): void {
  let pushed = false
  window.notch.events.on('claude:state-changed', (state) => {
    pushed = true
    useClaude.setState({ state })
  })
  void window.notch.claude.getState().then((result) => {
    if (result.ok && !pushed) useClaude.setState({ state: result.data })
  })
}
