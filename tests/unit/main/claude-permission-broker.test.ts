import { describe, expect, it, vi } from 'vitest'
import { createPermissionBroker, type PendingReply } from '../../../src/main/claude/permission-broker'
import type { HookEvent, HookEventName } from '../../../src/shared/claude/hook-events'

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'

const makeReply = () => {
  let closeCb: (() => void) | undefined
  const reply: PendingReply = {
    send: vi.fn(),
    onClose: (cb) => {
      closeCb = cb
    },
  }
  return { reply, send: reply.send as ReturnType<typeof vi.fn>, close: () => closeCb?.() }
}

const ev = (name: HookEventName, sessionId = 's1', extra: Partial<HookEvent> = {}): HookEvent => ({
  name,
  sessionId,
  ...extra,
})

const setup = () => {
  let n = 0
  let t = 1000
  const onChange = vi.fn()
  const broker = createPermissionBroker({
    newId: () => `id${++n}`,
    now: () => (t += 10),
    sessionName: (id) => `name-${id}`,
    onChange,
  })
  return { broker, onChange }
}

const request = (sessionId = 's1', toolName = 'Bash', preview = 'ls') =>
  ev('PermissionRequest', sessionId, { toolName, preview })

describe('permission broker', () => {
  it('queues holds in arrival order without exposing the reply', () => {
    const { broker } = setup()
    broker.hold(request('s1', 'Bash', 'ls'), makeReply().reply)
    broker.hold(request('s2', 'Edit', 'a.ts'), makeReply().reply)
    const list = broker.pending()
    expect(list).toEqual([
      { id: 'id1', sessionId: 's1', sessionName: 'name-s1', toolName: 'Bash', preview: 'ls', previewTruncated: false, previewLength: 2, receivedAt: 1010 },
      { id: 'id2', sessionId: 's2', sessionName: 'name-s2', toolName: 'Edit', preview: 'a.ts', previewTruncated: false, previewLength: 4, receivedAt: 1020 },
    ])
    expect(JSON.stringify(list)).not.toContain('reply')
    list[0]!.preview = 'mutated'
    expect(broker.pending()[0]!.preview).toBe('ls')
  })

  it('carries the truncation flag and the full preview length', () => {
    const { broker } = setup()
    broker.hold(ev('PermissionRequest', 's1', { toolName: 'Bash', preview: 'x'.repeat(2000), previewTruncated: true, previewLength: 2400 }), makeReply().reply)
    expect(broker.pending()[0]).toMatchObject({ previewTruncated: true, previewLength: 2400 })
  })

  it('decide sends the exact allow/deny JSON and removes the entry', () => {
    const { broker } = setup()
    const a = makeReply()
    const b = makeReply()
    broker.hold(request(), a.reply)
    broker.hold(request(), b.reply)
    expect(broker.decide('id1', 'allow')).toBe(true)
    expect(a.send).toHaveBeenCalledWith(ALLOW)
    expect(broker.decide('id2', 'deny')).toBe(true)
    expect(b.send).toHaveBeenCalledWith(DENY)
    expect(broker.pending()).toEqual([])
  })

  it('returns false and sends nothing for an unknown id', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(request(), a.reply)
    onChange.mockClear()
    expect(broker.decide('nope', 'allow')).toBe(false)
    expect(a.send).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('deciding the same id twice sends once', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.hold(request(), a.reply)
    expect(broker.decide('id1', 'allow')).toBe(true)
    expect(broker.decide('id1', 'deny')).toBe(false)
    expect(a.send).toHaveBeenCalledTimes(1)
  })

  it.each(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd'] as const)(
    'observe of %s (session-level end) from the same session releases with null',
    (name) => {
      const { broker } = setup()
      const a = makeReply()
      const other = makeReply()
      broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu1' }))
      broker.hold(request('s1'), a.reply)
      broker.hold(request('s2'), other.reply)
      broker.observe(ev(name, 's1'))
      expect(a.send).toHaveBeenCalledWith(null)
      expect(other.send).not.toHaveBeenCalled()
      expect(broker.pending().map((p) => p.id)).toEqual(['id2'])
    },
  )

  it.each(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'] as const)(
    '%s with the bound tool_use_id releases the request',
    (name) => {
      const { broker } = setup()
      const a = makeReply()
      broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu1' }))
      broker.hold(request('s1'), a.reply)
      broker.observe(ev(name, 's1', { toolName: 'Bash', toolUseId: 'tu-other' }))
      expect(a.send).not.toHaveBeenCalled()
      broker.observe(ev(name, 's1', { toolName: 'Bash', toolUseId: 'tu1' }))
      expect(a.send).toHaveBeenCalledWith(null)
      expect(broker.pending()).toEqual([])
    },
  )

  it('a PreToolUse never releases anything', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.hold(request('s1'), a.reply)
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu9' }))
    expect(a.send).not.toHaveBeenCalled()
  })

  it.each(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'] as const)(
    'without a bound id, %s of the same session and tool releases (other tools and sessions do not)',
    (name) => {
      const { broker } = setup()
      const a = makeReply()
      broker.hold(request('s1', 'Bash'), a.reply)
      broker.observe(ev(name, 's1', { toolName: 'Edit', toolUseId: 'x1' }))
      broker.observe(ev(name, 's2', { toolName: 'Bash', toolUseId: 'x2' }))
      expect(a.send).not.toHaveBeenCalled()
      broker.observe(ev(name, 's1', { toolName: 'Bash', toolUseId: 'x3' }))
      expect(a.send).toHaveBeenCalledWith(null)
    },
  )

  it('binds to the most recent unfinished PreToolUse of the same tool', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu1' }))
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu2' }))
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu2' }))
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Read', toolUseId: 'tu3' }))
    broker.hold(request('s1', 'Bash'), a.reply)
    // tu2 already finished and tu3 is another tool: the request belongs to tu1.
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Read', toolUseId: 'tu3' }))
    expect(a.send).not.toHaveBeenCalled()
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu1' }))
    expect(a.send).toHaveBeenCalledWith(null)
  })

  it('two parallel subagents in one session: B never releases A, A releases A', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'a1', agentId: 'agent-a' }))
    broker.hold(ev('PermissionRequest', 's1', { toolName: 'Bash', preview: 'npm test', agentId: 'agent-a' }), a.reply)
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'b1', agentId: 'agent-b' }))
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'b1', agentId: 'agent-b' }))
    broker.observe(ev('PostToolUseFailure', 's1', { toolName: 'Bash', toolUseId: 'b2', agentId: 'agent-b' }))
    broker.observe(ev('SubagentStop', 's1', { agentId: 'agent-b' }))
    expect(a.send).not.toHaveBeenCalled()
    expect(broker.pending()).toHaveLength(1)
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'a1', agentId: 'agent-a' }))
    expect(a.send).toHaveBeenCalledWith(null)
  })

  it('binds a subagent request only to a PreToolUse of the same agent', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'a1', agentId: 'agent-a' }))
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'b1', agentId: 'agent-b' }))
    broker.hold(ev('PermissionRequest', 's1', { toolName: 'Bash', agentId: 'agent-a' }), a.reply)
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'b1', agentId: 'agent-b' }))
    expect(a.send).not.toHaveBeenCalled()
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'a1', agentId: 'agent-a' }))
    expect(a.send).toHaveBeenCalledWith(null)
  })

  it('the spike sequence (PreToolUse x3, PermissionRequest, Notification, PostToolUse) releases on the PostToolUse', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Read', toolUseId: 'tu1' }))
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Grep', toolUseId: 'tu2' }))
    broker.observe(ev('PreToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu3' }))
    broker.hold(request('s1', 'Bash'), a.reply)
    broker.observe(ev('Notification', 's1', { notificationType: 'permission_prompt' }))
    expect(a.send).not.toHaveBeenCalled()
    broker.observe(ev('PostToolUse', 's1', { toolName: 'Bash', toolUseId: 'tu3' }))
    expect(a.send).toHaveBeenCalledWith(null)
  })

  it('observe of Notification or a new PermissionRequest does not release', () => {
    const { broker } = setup()
    const a = makeReply()
    broker.hold(request('s1'), a.reply)
    broker.observe(ev('Notification', 's1', { notificationType: 'permission_prompt' }))
    broker.observe(request('s1'))
    expect(a.send).not.toHaveBeenCalled()
    expect(broker.pending()).toHaveLength(1)
  })

  it('observe releases every queued entry of the session', () => {
    const { broker } = setup()
    const a = makeReply()
    const b = makeReply()
    broker.hold(request('s1'), a.reply)
    broker.hold(request('s1'), b.reply)
    broker.observe(ev('Stop', 's1'))
    expect(a.send).toHaveBeenCalledWith(null)
    expect(b.send).toHaveBeenCalledWith(null)
    expect(broker.pending()).toEqual([])
  })

  it('onClose removes the entry without sending', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(request(), a.reply)
    onChange.mockClear()
    a.close()
    expect(a.send).not.toHaveBeenCalled()
    expect(broker.pending()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('ignores onClose after a send', () => {
    const { broker, onChange } = setup()
    const a = makeReply()
    broker.hold(request(), a.reply)
    broker.decide('id1', 'allow')
    onChange.mockClear()
    a.close()
    expect(onChange).not.toHaveBeenCalled()
    expect(a.send).toHaveBeenCalledTimes(1)
  })

  it('releaseAll sends null to all and clears', () => {
    const { broker } = setup()
    const a = makeReply()
    const b = makeReply()
    broker.hold(request('s1'), a.reply)
    broker.hold(request('s2'), b.reply)
    broker.releaseAll()
    expect(a.send).toHaveBeenCalledWith(null)
    expect(b.send).toHaveBeenCalledWith(null)
    expect(broker.pending()).toEqual([])
    a.close()
    expect(a.send).toHaveBeenCalledTimes(1)
  })

  it('calls onChange on each change', () => {
    const { broker, onChange } = setup()
    broker.hold(request('s1'), makeReply().reply)
    expect(onChange).toHaveBeenCalledTimes(1)
    broker.hold(request('s2'), makeReply().reply)
    expect(onChange).toHaveBeenCalledTimes(2)
    broker.decide('id1', 'allow')
    expect(onChange).toHaveBeenCalledTimes(3)
    broker.observe(ev('Stop', 's2'))
    expect(onChange).toHaveBeenCalledTimes(4)
    broker.observe(ev('Stop', 's2'))
    expect(onChange).toHaveBeenCalledTimes(4)
    broker.hold(request('s3'), makeReply().reply)
    broker.releaseAll()
    expect(onChange).toHaveBeenCalledTimes(6)
  })
})
