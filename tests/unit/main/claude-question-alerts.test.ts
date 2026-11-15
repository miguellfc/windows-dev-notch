import { describe, expect, it, vi } from 'vitest'
import { createQuestionAlerts } from '../../../src/main/claude/question-alerts'
import type { PendingQuestionView } from '../../../src/shared/claude/types'
import type { NotchEvent, NotchMode } from '../../../src/shared/notch/state'
import { createMemoryLogger } from '../helpers/memory-logger'

const question: PendingQuestionView = {
  id: 'q1',
  project: 'my-project',
  arrivedAt: 1,
  questions: [
    {
      question: 'SECRET-QUESTION?',
      header: 'Pick',
      multiSelect: false,
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
    },
  ],
}

const setup = (mode: NotchMode = 'compact', destroyed = false) => {
  const order: string[] = []
  const events: NotchEvent[] = []
  const notch = {
    mode: () => mode,
    dispatch: (event: NotchEvent) => {
      events.push(event)
      order.push(`dispatch:${event.type}`)
    },
  }
  const sent: [string, unknown][] = []
  const target = {
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => {
      sent.push([channel, payload])
      order.push(`send:${channel}`)
    },
  }
  const toast = { show: vi.fn() }
  const logger = createMemoryLogger()
  const alerts = createQuestionAlerts({ notch, notchTarget: () => target, toast, logger })
  return { alerts, events, sent, order, toast, logger }
}

describe('createQuestionAlerts', () => {
  it('sends the list to the notch before turning the question alert on or off', () => {
    const { alerts, events, sent, order } = setup()
    alerts.onQuestions([question])
    alerts.onQuestions([])
    expect(sent).toEqual([
      ['claude:questions', [question]],
      ['claude:questions', []],
    ])
    expect(events.filter((event) => event.type === 'question')).toEqual([
      { type: 'question', on: true },
      { type: 'question', on: false },
    ])
    expect(order).toEqual([
      'send:claude:questions',
      'dispatch:claude-first',
      'dispatch:question',
      'send:claude:questions',
      'dispatch:claude-first',
      'dispatch:question',
    ])
  })

  it('never sends a list outside the contract (e.g. with the session id)', () => {
    const { alerts, sent, logger } = setup()
    alerts.onQuestions([{ ...question, sessionId: 's1' } as PendingQuestionView])
    expect(sent).toEqual([])
    expect(JSON.stringify(logger.entries)).not.toContain('SECRET')
  })

  it('toasts a new question with the panel closed; a click opens the panel', () => {
    const { alerts, toast, events } = setup('alert')
    alerts.onNewQuestion(question)
    expect(toast.show).toHaveBeenCalledTimes(1)
    expect(toast.show.mock.calls[0]![0]).toBe(question)
    const onClick = toast.show.mock.calls[0]![1] as () => void
    onClick()
    expect(events).toEqual([{ type: 'expand' }])
  })

  it.each(['expanded', 'permission', 'gmail'] as const)('does not toast while the %s panel is open', (mode) => {
    const { alerts, toast } = setup(mode)
    alerts.onNewQuestion(question)
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('skips a destroyed notch window', () => {
    const { alerts, sent, events } = setup('compact', true)
    alerts.onQuestions([question])
    expect(sent).toEqual([])
    expect(events).toContainEqual({ type: 'question', on: true })
  })

  describe('which pending Claude item came first (one bridge clock for both)', () => {
    const permission = (receivedAt: number) => ({ receivedAt })
    const firsts = (events: NotchEvent[]) => events.flatMap((event) => (event.type === 'claude-first' ? [event.kind] : []))

    it('tells the notch the kind of the earliest item whenever either list changes, before the flags', () => {
      const { alerts, events } = setup()
      alerts.onPermissions([permission(5), permission(2)])
      alerts.onQuestions([{ ...question, arrivedAt: 3 }])
      alerts.onPermissions([permission(5)])
      alerts.onQuestions([])
      alerts.onPermissions([])
      expect(firsts(events)).toEqual(['permission', 'permission', 'question', 'permission', 'permission'])
    })

    it('counts the earliest question of the list, whatever its position', () => {
      const { alerts, events } = setup()
      alerts.onPermissions([permission(4)])
      alerts.onQuestions([{ ...question, arrivedAt: 6 }, { ...question, id: 'q2', arrivedAt: 1 }])
      expect(firsts(events).at(-1)).toBe('question')
    })
  })
})

