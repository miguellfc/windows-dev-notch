import { describe, expect, it } from 'vitest'
import { bringClaudeToFront, type Win32FocusApi } from '../../../src/main/claude/bring-claude-to-front'

function fakeApi(overrides: Partial<Win32FocusApi> = {}) {
  const calls: string[] = []
  let foreground: unknown = 'other'
  const api: Win32FocusApi = {
    findClaudeWindow: () => 'claude-hwnd',
    getForegroundWindow: () => foreground,
    sameWindow: (a, b) => a === b,
    getWindowThreadId: () => 7,
    getCurrentThreadId: () => 1,
    attachThreadInput: (_a, _b, attach) => {
      calls.push(attach ? 'attach' : 'detach')
      return true
    },
    isIconic: () => false,
    restoreWindow: () => {
      calls.push('restore')
    },
    bringWindowToTop: () => {
      calls.push('top')
    },
    setForegroundWindow: (hwnd) => {
      calls.push('setfg')
      foreground = hwnd
    },
    ...overrides,
  }
  return { api, calls }
}

describe('bringClaudeToFront', () => {
  it('returns not-running when there is no claude.exe window', () => {
    const { api, calls } = fakeApi({ findClaudeWindow: () => null })
    expect(bringClaudeToFront(api)).toBe('not-running')
    expect(calls).toEqual([])
  })

  it('attaches, raises, focuses and detaches in order', () => {
    const { api, calls } = fakeApi()
    expect(bringClaudeToFront(api)).toBe('focused')
    expect(calls).toEqual(['attach', 'top', 'setfg', 'detach'])
  })

  it('restores a minimized window before raising it', () => {
    const { api, calls } = fakeApi({ isIconic: () => true })
    bringClaudeToFront(api)
    expect(calls).toEqual(['attach', 'restore', 'top', 'setfg', 'detach'])
  })

  it('returns blocked when the target does not become foreground', () => {
    const { api } = fakeApi({ setForegroundWindow: () => undefined })
    expect(bringClaudeToFront(api)).toBe('blocked')
  })

  it('always detaches, even when a step throws', () => {
    const { api, calls } = fakeApi({
      bringWindowToTop: () => {
        throw new Error('boom')
      },
    })
    expect(() => bringClaudeToFront(api)).toThrow('boom')
    expect(calls).toEqual(['attach', 'detach'])
  })

  it('does not detach when the attach failed', () => {
    const { api, calls } = fakeApi({ attachThreadInput: () => false })
    bringClaudeToFront(api)
    expect(calls).not.toContain('detach')
  })
})
