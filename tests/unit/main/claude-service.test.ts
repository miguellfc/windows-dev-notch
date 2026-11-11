import { describe, expect, it, vi } from 'vitest'
import { createClaudeBridge, type ClaudeBridge } from '../../../src/main/claude/claude-bridge'
import { createClaudeIpcHandlers } from '../../../src/main/claude/claude-ipc'
import {
  CONNECTION_TEST_SESSION_ID,
  createClaudeService,
  type ClaudeBridgeFactory,
  type ClaudeServiceDeps,
} from '../../../src/main/claude/claude-service'
import type { HookInstaller, HookStatus } from '../../../src/main/claude/hook-installer'
import type { PendingReply } from '../../../src/main/claude/permission-broker'
import { registerIpc, type IpcEventLike, type IpcMainLike } from '../../../src/main/ipc/register'
import type { HookEvent, HookEventName } from '../../../src/shared/claude/hook-events'
import type { ClaudeState, PendingPermission } from '../../../src/shared/claude/types'
import { contract } from '../../../src/shared/ipc/contract'
import { createMemoryLogger } from '../helpers/memory-logger'

const TOKEN = 'a'.repeat(64)
const NEW_TOKEN = 'b'.repeat(64)
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

type FakeBridge = ClaudeBridge & {
  options: Parameters<ClaudeBridgeFactory>[0]
  stopped: boolean
  emit: (e: HookEvent, reply?: PendingReply | null) => void
}

const fakeReply = () => {
  const sent: (string | null)[] = []
  let onClose: (() => void) | undefined
  const reply: PendingReply = {
    send: (body) => {
      sent.push(body)
    },
    onClose: (cb) => {
      onClose = cb
    },
  }
  return { reply, sent, close: () => onClose?.() }
}

const fakeInstaller = (initial: HookStatus = 'installed') => {
  let status: HookStatus = initial
  const tokenLine = (token: string) => ({ kind: 'add' as const, text: `          "x-notch-token": "${token}",` })
  const installer: HookInstaller & { setStatus: (s: HookStatus) => void } = {
    setStatus: (s) => {
      status = s
    },
    preview: vi.fn(async ({ token }) => ({ ok: true as const, next: `{"x-notch-token": "${token}"}`, diff: [tokenLine(token)] })),
    install: vi.fn(async ({ token }) => {
      status = 'installed'
      return { ok: true as const, changed: true, diff: [tokenLine(token)], backupFile: 'C:\\backups\\settings.json' }
    }),
    uninstall: vi.fn(async () => {
      status = 'missing'
      return { ok: true as const, changed: true, diff: [{ kind: 'remove' as const, text: `"x-notch-token": "${TOKEN}"` }] }
    }),
    status: vi.fn(async () => status),
  }
  return installer
}

const setup = (overrides: Partial<ClaudeServiceDeps> & { hooks?: HookStatus } = {}) => {
  let t = 1_000_000
  let ids = 0
  const bridges: FakeBridge[] = []
  const states: ClaudeState[] = []
  const newPending: PendingPermission[] = []
  const installer = fakeInstaller(overrides.hooks ?? 'installed')
  let token = TOKEN
  const deps: ClaudeServiceDeps = {
    logger: createMemoryLogger(),
    now: () => t,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    encryptionAvailable: () => true,
    loadConfig: async () => ({ port: 47600, token }),
    rotateConfig: async () => {
      token = NEW_TOKEN
      return { port: 47600, token }
    },
    rotatePortConfig: async () => ({ port: 50_001, token }),
    createBridge: (options) => {
      const bridge: FakeBridge = {
        options,
        stopped: false,
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          bridge.stopped = true
        }),
        port: () => options.port,
        emit: (e, reply = null) => options.onEvent(e, reply),
      }
      bridges.push(bridge)
      return bridge
    },
    installer,
    focusClaude: vi.fn(),
    onState: (s) => states.push(s),
    onNewPending: (p) => newPending.push(p),
    ...overrides,
  }
  const service = createClaudeService(deps)
  const bridge = () => bridges.at(-1)!
  const send = (name: HookEventName, extra: Partial<HookEvent> = {}, sessionId = 'session-1', reply: PendingReply | null = null) =>
    bridge().emit({ name, sessionId, cwd: 'C:\\work\\my-project', ...extra }, reply)
  const status = (id = 'session-1') => service.state().sessions.find((s) => s.id === id)?.status
  return {
    service,
    deps,
    bridges,
    bridge,
    states,
    newPending,
    installer,
    send,
    status,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('ClaudeService connection', () => {
  it('starts the bridge with the stored config and reports not-installed without hooks', async () => {
    const { service, bridges, states } = setup({ hooks: 'missing' })
    await service.start()
    expect(bridges).toHaveLength(1)
    expect(bridges[0]!.options).toMatchObject({ port: 47600, token: TOKEN })
    expect(bridges[0]!.start).toHaveBeenCalledOnce()
    expect(service.state()).toEqual({ connection: 'not-installed', hooks: 'missing', sessions: [], pending: [] })
    expect(states.at(-1)).toEqual(service.state())
  })

  it('waits for events once hooks are installed, and is connected after the first event', async () => {
    const { service, send } = setup({ hooks: 'installed' })
    await service.start()
    expect(service.state().connection).toBe('waiting-for-events')
    send('UserPromptSubmit')
    expect(service.state().connection).toBe('connected')
    expect(service.state().sessions).toMatchObject([{ id: 'session-1', name: 'my-project', status: 'working' }])
  })

  it('treats outdated hooks as installed for the connection and reports them', async () => {
    const { service } = setup({ hooks: 'outdated' })
    await service.start()
    expect(service.state()).toMatchObject({ connection: 'waiting-for-events', hooks: 'outdated' })
  })

  it('reports error and never starts a bridge when encryption is unavailable', async () => {
    const loadConfig = vi.fn()
    const { service, bridges } = setup({ encryptionAvailable: () => false, loadConfig })
    await service.start()
    expect(loadConfig).not.toHaveBeenCalled()
    expect(bridges).toHaveLength(0)
    expect(service.state()).toMatchObject({ connection: 'error', hooks: 'unknown' })
  })

  it('reports error when the port is taken, and keeps working otherwise', async () => {
    const { service, deps } = setup({
      createBridge: (options) => ({
        start: async () => {
          throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
        },
        stop: async () => undefined,
        port: () => options.port,
      }),
    })
    await expect(service.start()).resolves.toBeUndefined()
    expect(service.state().connection).toBe('error')
    await expect(service.testConnection()).resolves.toEqual({ ok: false })
    expect(deps.installer.status).toHaveBeenCalled()
  })

  it('ignores connection-test events entirely', async () => {
    const { service, send } = setup()
    await service.start()
    send('Notification', { notificationType: 'idle_prompt' }, CONNECTION_TEST_SESSION_ID)
    expect(service.state()).toMatchObject({ connection: 'waiting-for-events', sessions: [] })
  })
})

describe('ClaudeService permissions', () => {
  // The usage log measures alert latency in onNewPending as now - receivedAt: that is only valid if
  // the state carrying the request (which applies `attention`) was published first.
  it('publishes the state with a new request before announcing it, stamped when the hook arrived', async () => {
    const order: string[] = []
    const { service, send, advance } = setup({
      onState: (s) => order.push(`state:${s.pending.length}`),
      onNewPending: (p) => order.push(`new:${p.receivedAt}`),
    })
    await service.start()
    advance(500)
    order.length = 0
    // The bridge stamps the HTTP arrival (before the body was read); that time wins over the clock.
    send('PermissionRequest', { toolName: 'Bash', preview: 'npm test' }, 'session-1', { ...fakeReply().reply, arrivedAt: 1_000_420 })
    expect(order).toEqual(['state:1', `new:${1_000_420}`])
    // Without an arrival stamp (another transport), the service clock is used.
    send('PermissionRequest', { toolName: 'Read', preview: 'x' }, 'session-1', fakeReply().reply)
    expect(order.at(-1)).toBe(`new:${1_000_500}`)
  })

  it('holds a permission request, announces it once, and decides it', async () => {
    const { service, send, status, newPending, states } = setup()
    await service.start()
    const r = fakeReply()
    send('PreToolUse', { toolName: 'Bash' })
    send('PermissionRequest', { toolName: 'Bash', preview: 'npm test' }, 'session-1', r.reply)

    const [pending] = service.state().pending
    expect(pending).toMatchObject({ sessionId: 'session-1', sessionName: 'my-project', toolName: 'Bash', preview: 'npm test' })
    expect(status()).toBe('waiting')
    expect(newPending).toEqual([pending])
    expect(states.at(-1)!.pending).toHaveLength(1)

    send('Notification', { notificationType: 'permission_prompt' })
    expect(newPending).toHaveLength(1)

    expect(service.decide(pending!.id, 'allow')).toBe(true)
    expect(r.sent).toEqual([ALLOW])
    expect(service.state().pending).toEqual([])
    expect(status()).toBe('working')
    expect(states.at(-1)!.pending).toEqual([])
    expect(service.decide(pending!.id, 'deny')).toBe(false)
  })

  it('the PostToolUse of the same tool call releases the request without a decision', async () => {
    const { service, send, status } = setup()
    await service.start()
    const r = fakeReply()
    send('PreToolUse', { toolName: 'Bash', toolUseId: 'tu1' })
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', r.reply)
    send('PreToolUse', { toolName: 'Bash', toolUseId: 'tu2' })
    send('PostToolUse', { toolName: 'Bash', toolUseId: 'tu2' })
    expect(r.sent).toEqual([])
    send('PostToolUse', { toolName: 'Bash', toolUseId: 'tu1' })
    expect(r.sent).toEqual([null])
    expect(service.state().pending).toEqual([])
    expect(status()).toBe('working')
  })

  it.each(['UserPromptSubmit', 'StopFailure'] as const)('%s of the session releases the request (answered or interrupted in Claude)', async (name) => {
    const { service, send } = setup()
    await service.start()
    const r = fakeReply()
    send('PreToolUse', { toolName: 'Bash', toolUseId: 'tu1' })
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', r.reply)
    send(name)
    expect(r.sent).toEqual([null])
    expect(service.state().pending).toEqual([])
  })

  it('leaves waiting when Claude closes the held connection', async () => {
    const { service, send, status, states } = setup()
    await service.start()
    const r = fakeReply()
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', r.reply)
    r.close()
    expect(service.state().pending).toEqual([])
    expect(status()).toBe('working')
    expect(states.at(-1)!.sessions[0]!.status).toBe('working')
  })

  it('stays waiting while the session still has another pending request', async () => {
    const { service, send, status } = setup()
    await service.start()
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', fakeReply().reply)
    send('PermissionRequest', { toolName: 'Edit' }, 'session-1', fakeReply().reply)
    const [first] = service.state().pending
    service.decide(first!.id, 'deny')
    expect(service.state().pending).toHaveLength(1)
    expect(status()).toBe('waiting')
  })

  it('stop releases every request without a decision and stops the bridge', async () => {
    const { service, send, status, bridge } = setup()
    await service.start()
    const r = fakeReply()
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', r.reply)
    await service.stop()
    expect(r.sent).toEqual([null])
    expect(status()).toBe('working')
    expect(bridge().stopped).toBe(true)
  })
})

describe('ClaudeService sessions', () => {
  it('tick marks quiet sessions idle and emits only when something changed', async () => {
    const { service, send, states, advance, status } = setup()
    await service.start()
    send('Stop')
    const before = states.length
    await service.tick()
    expect(states).toHaveLength(before)
    advance(31 * 60_000)
    await service.tick()
    expect(status()).toBe('idle')
    expect(states).toHaveLength(before + 1)
  })

  it('a waiting session goes idle after 30 min only when no request of it is held', async () => {
    const { service, send, advance, status } = setup()
    await service.start()
    send('Notification', { notificationType: 'permission_prompt' }, 'no-held')
    send('PermissionRequest', { toolName: 'Bash' }, 'held', fakeReply().reply)
    advance(31 * 60_000)
    await service.tick()
    expect(status('no-held')).toBe('idle')
    expect(status('held')).toBe('waiting')
  })

  it('tick picks up hooks changed outside the app', async () => {
    const { service, installer } = setup({ hooks: 'installed' })
    await service.start()
    installer.setStatus('missing')
    await service.tick()
    expect(service.state()).toMatchObject({ connection: 'not-installed', hooks: 'missing' })
  })

  it('dismisses only idle sessions', async () => {
    const { service, send, advance } = setup()
    await service.start()
    send('Stop')
    expect(service.dismissSession('session-1')).toBe(false)
    advance(31 * 60_000)
    await service.tick()
    expect(service.dismissSession('session-1')).toBe(true)
    expect(service.state().sessions).toEqual([])
  })
})

describe('ClaudeService hooks and token', () => {
  it('masks the token in previews and write results, and refreshes the hook status', async () => {
    const { service } = setup({ hooks: 'missing' })
    await service.start()
    const preview = await service.previewHooks()
    expect(JSON.stringify(preview)).not.toContain(TOKEN)
    expect(preview).toEqual({ ok: true, diff: [{ kind: 'add', text: '          "x-notch-token": "••••••",' }] })

    const installed = await service.installHooks()
    expect(JSON.stringify(installed)).not.toContain(TOKEN)
    expect(installed).toMatchObject({ ok: true, changed: true, backupFile: 'C:\\backups\\settings.json' })
    expect(service.state()).toMatchObject({ hooks: 'installed', connection: 'waiting-for-events' })

    const removed = await service.uninstallHooks()
    expect(JSON.stringify(removed)).not.toContain(TOKEN)
    expect(service.state()).toMatchObject({ hooks: 'missing', connection: 'not-installed' })
  })

  it('refuses hook installs without a bridge config', async () => {
    const { service } = setup({ encryptionAvailable: () => false })
    await service.start()
    await expect(service.installHooks()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(service.previewHooks()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('rotating the token restarts the bridge and reinstalls installed hooks', async () => {
    const { service, bridges, installer, send } = setup({ hooks: 'installed' })
    await service.start()
    const r = fakeReply()
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', r.reply)
    await expect(service.rotateToken()).resolves.toEqual({ hooks: 'reinstalled' })
    expect(r.sent).toEqual([null])
    expect(bridges).toHaveLength(2)
    expect(bridges[0]!.stopped).toBe(true)
    expect(bridges[1]!.options).toMatchObject({ port: 47600, token: NEW_TOKEN })
    expect(bridges[1]!.start).toHaveBeenCalledOnce()
    expect(installer.install).toHaveBeenCalledWith({ port: 47600, token: NEW_TOKEN })
  })

  it('rotating the token does not install hooks that were not installed', async () => {
    const { service, installer } = setup({ hooks: 'missing' })
    await service.start()
    await expect(service.rotateToken()).resolves.toEqual({ hooks: 'not-installed' })
    expect(installer.install).not.toHaveBeenCalled()
  })

  it('rotating reports a failed reinstall (invalid settings.json or a write error) instead of success', async () => {
    const { service, installer } = setup({ hooks: 'installed' })
    await service.start()
    vi.mocked(installer.install).mockResolvedValueOnce({ ok: false, reason: 'invalid-json' })
    await expect(service.rotateToken()).resolves.toEqual({ hooks: 'reinstall-failed' })
    installer.setStatus('outdated')
    vi.mocked(installer.install).mockRejectedValueOnce(new Error('EPERM'))
    await expect(service.rotateToken()).resolves.toEqual({ hooks: 'reinstall-failed' })
    expect(service.state().connection).toBe('waiting-for-events')
  })

  it('reports port-in-use when the bridge port is taken', async () => {
    const { service } = setup({
      createBridge: (options) => ({
        start: async () => {
          throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
        },
        stop: async () => undefined,
        port: () => options.port,
      }),
    })
    await service.start()
    expect(service.state()).toMatchObject({ connection: 'error', reason: 'port-in-use' })
  })

  it('other bridge errors carry no port-in-use reason', async () => {
    const { service } = setup({
      createBridge: (options) => ({
        start: async () => {
          throw Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
        },
        stop: async () => undefined,
        port: () => options.port,
      }),
    })
    await service.start()
    expect(service.state().connection).toBe('error')
    expect(service.state()).not.toHaveProperty('reason')
  })

  it('rotatePort moves the bridge to the new port, reinstalls installed hooks and clears port-in-use', async () => {
    const started: number[] = []
    const { service, installer } = setup({
      hooks: 'installed',
      createBridge: (options) => ({
        start: async () => {
          if (options.port === 47600) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
          started.push(options.port)
        },
        stop: async () => undefined,
        port: () => options.port,
      }),
    })
    await service.start()
    expect(service.state()).toMatchObject({ connection: 'error', reason: 'port-in-use' })
    await expect(service.rotatePort()).resolves.toEqual({ hooks: 'reinstalled' })
    expect(started).toEqual([50_001])
    expect(installer.install).toHaveBeenCalledWith({ port: 50_001, token: TOKEN })
    expect(service.state().connection).toBe('waiting-for-events')
    expect(service.state()).not.toHaveProperty('reason')
  })

  it('rotatePort without hooks installed does not install them', async () => {
    const { service, installer } = setup({ hooks: 'missing' })
    await service.start()
    await expect(service.rotatePort()).resolves.toEqual({ hooks: 'not-installed' })
    expect(installer.install).not.toHaveBeenCalled()
  })

  it('never puts the token in the state', async () => {
    const { service, send, states } = setup()
    await service.start()
    send('UserPromptSubmit')
    send('PermissionRequest', { toolName: 'Bash', preview: 'echo hi' }, 'session-1', fakeReply().reply)
    await service.rotateToken()
    const everything = JSON.stringify([service.state(), ...states])
    expect(service.state().pending).toHaveLength(0)
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(NEW_TOKEN)
  })
})

describe('ClaudeService test connection', () => {
  it('POSTs a real hook event to the running bridge with the current token', async () => {
    const logger = createMemoryLogger()
    const { service } = setup({
      loadConfig: async () => ({ port: 0, token: TOKEN }),
      createBridge: (options) => createClaudeBridge({ ...options, logger }),
    })
    await service.start()
    try {
      await expect(service.testConnection()).resolves.toEqual({ ok: true })
      expect(service.state()).toMatchObject({ sessions: [], connection: 'waiting-for-events' })
      expect(logger.entries.some((e) => e.message === 'hook request' && (e.meta as { status: unknown }).status === 200)).toBe(true)
      expect(JSON.stringify(logger.entries)).not.toContain(TOKEN)
    } finally {
      await service.stop()
    }
  })

  it('fails when the bridge rejects the token', async () => {
    const logger = createMemoryLogger()
    const { service } = setup({
      loadConfig: async () => ({ port: 0, token: TOKEN }),
      createBridge: (options) => createClaudeBridge({ ...options, token: NEW_TOKEN, logger }),
    })
    await service.start()
    try {
      await expect(service.testConnection()).resolves.toEqual({ ok: false })
    } finally {
      await service.stop()
    }
  })
})

describe('Claude IPC handlers', () => {
  const trustedEvent: IpcEventLike = { sender: { id: 1 }, senderFrame: { url: 'app://trusted', parent: null } }

  const register = (service: ReturnType<typeof setup>['service']) => {
    const listeners = new Map<string, (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => listeners.set(channel, listener),
      removeHandler: (channel) => listeners.delete(channel),
    }
    const claude = createClaudeIpcHandlers(service)
    const others = Object.fromEntries(
      Object.keys(contract)
        .filter((c) => !c.startsWith('claude:'))
        .map((c) => [c, () => null]),
    )
    registerIpc({
      ipcMain,
      handlers: { ...others, ...claude } as never,
      isTrustedUrl: (url) => url === 'app://trusted',
      logger: createMemoryLogger(),
    })
    return (channel: string, ...args: unknown[]) => listeners.get(channel)!(trustedEvent, ...args)
  }

  it('claude:decide with an unknown id is NOT_FOUND', async () => {
    const { service } = setup()
    await service.start()
    const invoke = register(service)
    await expect(
      invoke('claude:decide', { requestId: '11111111-1111-4111-8111-111111111111', decision: 'allow' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('claude:decide answers a pending request', async () => {
    const { service, send } = setup()
    await service.start()
    const r = fakeReply()
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', r.reply)
    const invoke = register(service)
    const requestId = service.state().pending[0]!.id
    await expect(invoke('claude:decide', { requestId, decision: 'allow' })).resolves.toEqual({ ok: true, data: null })
    expect(r.sent).toEqual([ALLOW])
  })

  it('claude:dismiss-session on a session that is not idle is NOT_FOUND', async () => {
    const { service, send } = setup()
    await service.start()
    send('Stop')
    const invoke = register(service)
    await expect(invoke('claude:dismiss-session', { sessionId: 'session-1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })

  it('claude:focus-app brings the Claude app forward', async () => {
    const { service, deps } = setup()
    await service.start()
    const invoke = register(service)
    await expect(invoke('claude:focus-app')).resolves.toEqual({ ok: true, data: null })
    expect(deps.focusClaude).toHaveBeenCalledOnce()
  })

  it('no claude:* response carries the token', async () => {
    const { service, send } = setup({ hooks: 'missing' })
    await service.start()
    send('PermissionRequest', { toolName: 'Bash' }, 'session-1', fakeReply().reply)
    const invoke = register(service)
    const results = [
      await invoke('claude:get-state'),
      await invoke('claude:hooks-preview'),
      await invoke('claude:hooks-install'),
      await invoke('claude:test-connection'),
      await invoke('claude:hooks-uninstall'),
      await invoke('claude:rotate-token'),
      await invoke('claude:rotate-port'),
      await invoke('claude:get-state'),
    ]
    for (const result of results) expect(result).toMatchObject({ ok: true })
    const text = JSON.stringify(results)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(NEW_TOKEN)
  })
})
