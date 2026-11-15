import { describe, expect, it, vi } from 'vitest'
import type { PendingReply } from '../../../src/main/claude/permission-broker'
import { createQuestionBroker } from '../../../src/main/claude/question-broker'
import type { HookEvent, HookEventName } from '../../../src/shared/claude/hook-events'
import { questionResponseBody, type AskQuestion } from '../../../src/shared/claude/questions'

const makeReply = (arrivedAt?: number) => {
  let closeCb: (() => void) | undefined
  const reply: PendingReply = {
    ...(arrivedAt === undefined ? {} : { arrivedAt }),
    send: vi.fn(),
    onClose: (cb) => {
      closeCb = cb
    },
  }
  return { reply, send: reply.send as ReturnType<typeof vi.fn>, close: () => closeCb?.() }
}

const single: AskQuestion = {
  question: 'Fruit?',
  header: 'Pick',
  multiSelect: false,
  options: [
    { label: 'Apple', description: 'red' },
    { label: 'Pear', description: 'green' },
  ],
}

const ev = (name: HookEventName, sessionId = 's1', extra: Partial<HookEvent> = {}): HookEvent => ({ name, sessionId, ...extra })

const ask = (sessionId = 's1', toolUseId = 'tu1', questions: AskQuestion[] = [single]): HookEvent =>
  ev('PreToolUse', sessionId, { toolName: 'AskUserQuestion', toolUseId, askUserQuestion: { questions }, askUserQuestionRaw: { questions } })

const setup = () => {
  let n = 0
  let t = 1000
  const onChange = vi.fn()
  const broker = createQuestionBroker({
    newId: () => `id${++n}`,
    now: () => (t += 10),
    sessionName: (id) => `name-${id}`,
    onChange,
  })
  return { broker, onChange }
}

describe('question broker', () => {
  it('names the project from the session and the cwd of the event', () => {
    const sessionName = vi.fn((id: string, cwd?: string) => `${id}:${cwd ?? '-'}`)
    const broker = createQuestionBroker({ newId: () => 'q', now: () => 1, sessionName, onChange: () => undefined })
    broker.hold({ ...ask('s9'), cwd: 'C:\\work\\first-seen' }, makeReply().reply)
    expect(sessionName).toHaveBeenCalledWith('s9', 'C:\\work\\first-seen')
    expect(broker.pending()[0]!.project).toBe('s9:C:\\work\\first-seen')
  })

  it('answers {} at once and holds nothing without a valid askUserQuestion', () => {
    const { broker, onChange } = setup()
    const invalid = makeReply()
    broker.hold(ev('PreToolUse', 's1', { toolName: 'AskUserQuestion', toolUseId: 'tu1', askUserQuestion: null }), invalid.reply)
    expect(invalid.send).toHaveBeenCalledWith('{}')
    const missing = makeReply()
    broker.hold(ev('PreToolUse', 's1', { toolName: 'AskUserQuestion', toolUseId: 'tu2' }), missing.reply)
    expect(missing.send).toHaveBeenCalledWith('{}')
    const other = makeReply()
    broker.hold({ ...ask(), name: 'PermissionRequest' }, other.reply)
    expect(other.send).toHaveBeenCalledWith('{}')
    expect(broker.pending()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('queues questions in arrival order without exposing the reply', () => {
    const { broker, onChange } = setup()
    broker.hold(ask('s1', 'tu1'), makeReply(500).reply)
    broker.hold(ask('s2', 'tu2'), makeReply().reply)
    const list = broker.pending()
    expect(list).toEqual([
      { id: 'id1', sessionId: 's1', project: 'name-s1', questions: [single], arrivedAt: 500 },
      { id: 'id2', sessionId: 's2', project: 'name-s2', questions: [single], arrivedAt: 1010 },
    ])
    expect(JSON.stringify(list)).not.toContain('reply')
    expect(onChange).toHaveBeenCalledTimes(2)
    list[0]!.questions[0]!.options[0]!.label = 'mutated'
    expect(broker.pending()[0]!.questions[0]!.options[0]!.label).toBe('Apple')
  })

  it('answer sends the exact allow body built from the held questions and removes the entry', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    onChange.mockClear()
    expect(broker.answer('id1', [{ selected: [1] }])).toBe('sent')
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(a.send).toHaveBeenCalledWith(questionResponseBody({ questions: [single] }, { 'Fruit?': 'Pear' }))
    expect(broker.pending()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(broker.answer('id1', [{ selected: [1] }])).toBe('gone')
  })

  it('answer returns invalid and sends nothing when the answers break the rules', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    onChange.mockClear()
    expect(broker.answer('id1', [{ selected: [0, 1] }])).toBe('invalid')
    expect(broker.answer('id1', [{ selected: [5] }])).toBe('invalid')
    expect(broker.answer('id1', [])).toBe('invalid')
    expect(a.send).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(broker.pending()).toHaveLength(1)
  })

  it('answer returns gone for an unknown id', () => {
    const { broker } = setup()
    expect(broker.answer('nope', [{ selected: [0] }])).toBe('gone')
  })

  it('release sends {} and removes the entry; an unknown id returns false', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    onChange.mockClear()
    expect(broker.release('id1')).toBe(true)
    expect(a.send).toHaveBeenCalledWith('{}')
    expect(broker.pending()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(broker.release('id1')).toBe(false)
    expect(a.send).toHaveBeenCalledTimes(1)
  })

  it.each(['PostToolUse', 'PostToolUseFailure'] as const)('%s with the same tool_use_id releases only that question', (name) => {
    const { broker } = setup()
    const a = makeReply()
    const b = makeReply()
    const c = makeReply()
    broker.hold(ask('s1', 'tu1'), a.reply)
    broker.hold(ask('s1', 'tu2'), b.reply)
    broker.hold(ask('s2', 'tu1'), c.reply)
    broker.observe(ev(name, 's1', { toolName: 'AskUserQuestion', toolUseId: 'tu1' }))
    expect(a.send).toHaveBeenCalledWith('{}')
    expect(b.send).not.toHaveBeenCalled()
    expect(c.send).not.toHaveBeenCalled()
    expect(broker.pending().map((p) => p.id)).toEqual(['id2', 'id3'])
  })

  it('a tool end without tool_use_id releases nothing', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    broker.observe(ev('PostToolUse', 's1', { toolName: 'AskUserQuestion' }))
    broker.observe(ev('PermissionDenied', 's1', { toolName: 'AskUserQuestion', toolUseId: 'tu1' }))
    expect(a.send).not.toHaveBeenCalled()
    expect(broker.pending()).toHaveLength(1)
  })

  it.each(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit'] as const)('%s releases only the questions of that session', (name) => {
    const { broker, onChange } = setup()
    const a = makeReply()
    const b = makeReply()
    const c = makeReply()
    broker.hold(ask('s1', 'tu1'), a.reply)
    broker.hold(ask('s1', 'tu2'), b.reply)
    broker.hold(ask('s2', 'tu3'), c.reply)
    onChange.mockClear()
    broker.observe(ev(name, 's1'))
    expect(a.send).toHaveBeenCalledWith('{}')
    expect(b.send).toHaveBeenCalledWith('{}')
    expect(c.send).not.toHaveBeenCalled()
    expect(broker.pending().map((p) => p.id)).toEqual(['id3'])
    expect(onChange).toHaveBeenCalled()
  })

  it.each(['PreToolUse', 'Notification', 'PermissionRequest', 'SubagentStart', 'SubagentStop'] as const)('%s never releases', (name) => {
    const { broker } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    broker.observe(ev(name, 's1', { toolUseId: 'tu1' }))
    expect(a.send).not.toHaveBeenCalled()
    expect(broker.pending()).toHaveLength(1)
  })

  it('a closed socket removes the question and a later answer is gone', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    onChange.mockClear()
    a.close()
    expect(broker.pending()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(broker.answer('id1', [{ selected: [0] }])).toBe('gone')
    expect(broker.release('id1')).toBe(false)
    expect(a.send).not.toHaveBeenCalled()
  })

  it('a close after the answer is a no-op', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(ask(), a.reply)
    broker.answer('id1', [{ selected: [0] }])
    onChange.mockClear()
    a.close()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('releaseAll sends {} to every held question', () => {
    const { broker } = setup()
    const a = makeReply()
    const b = makeReply()
    broker.hold(ask('s1', 'tu1'), a.reply)
    broker.hold(ask('s2', 'tu2'), b.reply)
    broker.releaseAll()
    expect(a.send).toHaveBeenCalledWith('{}')
    expect(b.send).toHaveBeenCalledWith('{}')
    expect(broker.pending()).toEqual([])
  })

  it('answers with the raw tool_input, unknown keys included, not the validated copy', () => {
    const { broker } = setup()
    const a = makeReply()
    const raw = { meta: { v: 2 }, questions: [{ ...single, extra: 1, options: [{ ...single.options[0]!, icon: '*' }, single.options[1]!] }] }
    broker.hold({ ...ask(), askUserQuestionRaw: raw }, a.reply)
    expect(broker.pending()[0]!.questions).toEqual([single])
    expect(broker.answer('id1', [{ selected: [0] }])).toBe('sent')
    const body = JSON.parse(a.send.mock.calls[0]![0] as string) as { hookSpecificOutput: { updatedInput: unknown } }
    expect(body.hookSpecificOutput.updatedInput).toEqual({ ...raw, answers: { 'Fruit?': 'Apple' } })
  })

  it('a send that throws still removes the entry, notifies, releases the others and answers gone', () => {
    const { broker, onChange } = setup()
    const bad = makeReply()
    bad.send.mockImplementation(() => {
      throw new Error('socket gone')
    })
    const good = makeReply()
    broker.hold(ask('s1', 'tu1'), bad.reply)
    broker.hold(ask('s1', 'tu2'), good.reply)
    onChange.mockClear()
    expect(() => broker.releaseAll()).not.toThrow()
    expect(good.send).toHaveBeenCalledWith('{}')
    expect(broker.pending()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2)

    broker.hold(ask('s2', 'tu3'), bad.reply)
    broker.hold(ask('s2', 'tu4'), good.reply)
    expect(() => broker.observe(ev('Stop', 's2'))).not.toThrow()
    expect(good.send).toHaveBeenCalledTimes(2)
    expect(broker.pending()).toEqual([])

    broker.hold(ask('s3', 'tu5'), bad.reply)
    expect(broker.answer('id5', [{ selected: [0] }])).toBe('gone')
    expect(broker.pending()).toEqual([])
  })

  it('an immediate {} that throws does not escape hold', () => {
    const { broker } = setup()
    const bad = makeReply()
    bad.send.mockImplementation(() => {
      throw new Error('socket gone')
    })
    expect(() => broker.hold(ev('PreToolUse', 's1', { askUserQuestion: null }), bad.reply)).not.toThrow()
  })
})
