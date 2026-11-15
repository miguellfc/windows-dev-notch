import { describe, expect, it } from 'vitest'
import { createSessionRegistry } from '../../../src/main/claude/session-registry'
import type { HookEvent, HookEventName } from '../../../src/shared/claude/hook-events'

const setup = () => {
  let t = 1_000
  const registry = createSessionRegistry({ now: () => t })
  const advance = (ms: number): void => {
    t += ms
  }
  const send = (name: HookEventName, extra: Partial<HookEvent> = {}, sessionId = 'abcdef123456'): void => {
    registry.apply({ name, sessionId, cwd: 'C:\\work\\my-project', ...extra })
    advance(10)
  }
  const status = (id = 'abcdef123456'): string | undefined => registry.sessions().find((s) => s.id === id)?.status
  return { registry, send, status, advance }
}

describe('SessionRegistry', () => {
  it('walks the default-mode sequence working -> waiting -> working -> done', () => {
    const { send, status } = setup()
    send('UserPromptSubmit')
    expect(status()).toBe('working')
    send('PreToolUse', { toolName: 'Bash' })
    expect(status()).toBe('working')
    send('PermissionRequest', { toolName: 'Bash' })
    expect(status()).toBe('waiting')
    send('Notification', { notificationType: 'permission_prompt' })
    expect(status()).toBe('waiting')
    send('PostToolUse')
    expect(status()).toBe('working')
    send('Stop')
    expect(status()).toBe('done')
  })

  it('treats a permission_prompt notification without PermissionRequest as waiting', () => {
    const { send, status } = setup()
    send('Notification', { notificationType: 'permission_prompt' })
    expect(status()).toBe('waiting')
  })

  it('other notifications only refresh updatedAt', () => {
    const { registry, send, status } = setup()
    send('Stop')
    const before = registry.sessions()[0]!.updatedAt
    send('Notification', { notificationType: 'idle_prompt' })
    expect(status()).toBe('done')
    expect(registry.sessions()[0]!.updatedAt).toBeGreaterThan(before)
  })

  it('StopFailure sets error and PermissionDenied returns to working', () => {
    const { send, status } = setup()
    send('PermissionRequest')
    send('PermissionDenied')
    expect(status()).toBe('working')
    send('StopFailure')
    expect(status()).toBe('error')
  })

  it('SessionEnd removes the session', () => {
    const { registry, send } = setup()
    send('UserPromptSubmit')
    send('SessionEnd')
    expect(registry.sessions()).toEqual([])
  })

  it('SubagentStop after Stop keeps done, otherwise working; SubagentStart works', () => {
    const { send, status } = setup()
    send('SubagentStart')
    expect(status()).toBe('working')
    send('SubagentStop')
    expect(status()).toBe('working')
    send('Stop')
    send('SubagentStop')
    expect(status()).toBe('done')
  })

  it('goes idle after 30 minutes without events; tick reports changes only', () => {
    const { registry, send, status, advance } = setup()
    send('Stop')
    expect(registry.tick()).toBe(false)
    advance(1_800_000)
    expect(registry.tick()).toBe(true)
    expect(status()).toBe('idle')
    expect(registry.tick()).toBe(false)
  })

  it('any event revives an idle session', () => {
    const { send, status, advance, registry } = setup()
    send('Stop')
    advance(1_800_000)
    registry.tick()
    send('Notification', { notificationType: 'idle_prompt' })
    expect(status()).toBe('done')
    send('PreToolUse')
    expect(status()).toBe('working')
  })

  it('dismiss only works on idle sessions', () => {
    const { registry, send, advance } = setup()
    send('Stop')
    expect(registry.dismiss('abcdef123456')).toBe(false)
    advance(1_800_000)
    registry.tick()
    expect(registry.dismiss('abcdef123456')).toBe(true)
    expect(registry.sessions()).toEqual([])
    expect(registry.dismiss('abcdef123456')).toBe(false)
  })

  it('name is the last cwd segment, falling back to the first 8 id chars', () => {
    const { registry, send } = setup()
    send('Stop')
    registry.apply({ name: 'Stop', sessionId: 'zzzzzzzz9999' })
    send('Stop', { cwd: 'C:\\a\\b\\' }, 'trailing-1')
    const byId = Object.fromEntries(registry.sessions().map((s) => [s.id, s.name]))
    expect(byId['abcdef123456']).toBe('my-project')
    expect(byId['zzzzzzzz9999']).toBe('zzzzzzzz')
    expect(byId['trailing-1']).toBe('b')
    expect(registry.nameOf('abcdef123456')).toBe('my-project')
    expect(registry.nameOf('unknown-session')).toBe('unknown-')
  })

  it('never moves a waiting session with a held request to idle', () => {
    const { registry, send, status, advance } = setup()
    send('PermissionRequest')
    advance(31 * 60_000)
    expect(registry.tick(new Set(['abcdef123456']))).toBe(false)
    expect(status()).toBe('waiting')
    expect(registry.dismiss('abcdef123456')).toBe(false)
  })

  it('a waiting session without a held request goes idle after 30 minutes like the others', () => {
    const { registry, send, status, advance } = setup()
    send('Notification', { notificationType: 'permission_prompt' })
    advance(29 * 60_000)
    expect(registry.tick(new Set())).toBe(false)
    advance(2 * 60_000)
    expect(registry.tick(new Set(['other-session']))).toBe(true)
    expect(status()).toBe('idle')
  })

  it('PostToolUseFailure counts as activity (working)', () => {
    const { send, status } = setup()
    send('PermissionRequest', { toolName: 'Bash' })
    send('PostToolUseFailure', { toolName: 'Bash', toolUseId: 'tu1' })
    expect(status()).toBe('working')
  })

  it('an unusable cwd does not overwrite an existing name', () => {
    const { registry, send } = setup()
    send('Stop')
    send('PreToolUse', { cwd: '' })
    send('PreToolUse', { cwd: '/' })
    expect(registry.nameOf('abcdef123456')).toBe('my-project')
    registry.apply({ name: 'Stop', sessionId: 'newsession1', cwd: '/' })
    expect(registry.nameOf('newsession1')).toBe('newsessi')
  })

  it('resolveWaiting moves only a waiting session back to working', () => {
    const { registry, send, status } = setup()
    send('PermissionRequest')
    const before = registry.sessions()[0]!.updatedAt
    expect(registry.resolveWaiting('abcdef123456')).toBe(true)
    expect(status()).toBe('working')
    expect(registry.sessions()[0]!.updatedAt).toBeGreaterThanOrEqual(before)

    send('Stop')
    expect(registry.resolveWaiting('abcdef123456')).toBe(false)
    expect(status()).toBe('done')
    expect(registry.resolveWaiting('missing-session')).toBe(false)
  })

  it('orders by updatedAt descending', () => {
    const { registry, send } = setup()
    send('Stop', {}, 'a-session-1')
    send('Stop', {}, 'b-session-2')
    send('PreToolUse', {}, 'a-session-1')
    expect(registry.sessions().map((s) => s.id)).toEqual(['a-session-1', 'b-session-2'])
  })
})

describe('SessionRegistry markWaiting and nameOf', () => {
  it('marks a known session waiting (status and resume status) and reports whether it changed', () => {
    const { registry, send, status, advance } = setup()
    send('PreToolUse', { toolName: 'Bash' })
    expect(registry.markWaiting('abcdef123456')).toBe(true)
    expect(status()).toBe('waiting')
    const at = registry.sessions()[0]!.updatedAt
    advance(100)
    expect(registry.markWaiting('abcdef123456')).toBe(false)
    expect(registry.sessions()[0]!.updatedAt).toBe(at)
    // Resume status is waiting too: an idle session comes back waiting.
    advance(31 * 60_000)
    registry.tick()
    expect(status()).toBe('idle')
    registry.apply({ name: 'Notification', sessionId: 'abcdef123456', notificationType: 'idle_prompt' })
    expect(status()).toBe('waiting')
    expect(registry.resolveWaiting('abcdef123456')).toBe(true)
    expect(status()).toBe('working')
  })

  it('creates a session first seen waiting, named from its cwd', () => {
    const { registry, status } = setup()
    expect(registry.markWaiting('newsession99', 'C:\\work\\fresh-project\\')).toBe(true)
    expect(registry.sessions()).toEqual([{ id: 'newsession99', name: 'fresh-project', status: 'waiting', updatedAt: 1_000 }])
    expect(status('newsession99')).toBe('waiting')
    expect(registry.markWaiting('nocwd-session')).toBe(true)
    expect(registry.nameOf('nocwd-session')).toBe('nocwd-se')
  })

  it('nameOf falls back to the cwd before the id prefix for an unknown session', () => {
    const { registry, send } = setup()
    send('UserPromptSubmit')
    expect(registry.nameOf('abcdef123456', 'C:\\work\\other')).toBe('my-project')
    expect(registry.nameOf('unknown-session', 'C:\\work\\from-cwd')).toBe('from-cwd')
    expect(registry.nameOf('unknown-session')).toBe('unknown-')
  })
})
