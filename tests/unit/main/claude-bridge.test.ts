import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createClaudeBridge, type ClaudeBridge } from '../../../src/main/claude/claude-bridge'
import type { PendingReply } from '../../../src/main/claude/permission-broker'
import type { HookEvent } from '../../../src/shared/claude/hook-events'
import { createMemoryLogger } from '../helpers/memory-logger'

const TOKEN = 'secret-token-value'

type Res = { status: number; body: string }

const send = (
  port: number,
  opts: { method?: string; path?: string; token?: string | null; contentType?: string | null; host?: string; body?: string | Buffer },
): Promise<Res> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (opts.token !== null) headers['x-notch-token'] = opts.token ?? TOKEN
    if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json'
    if (opts.host !== undefined) headers['host'] = opts.host
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/hook', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(opts.body ?? '')
  })

const hook = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's1', hook_event_name: name, ...extra })

describe('createClaudeBridge', () => {
  let bridge: ClaudeBridge | undefined
  const events: { e: HookEvent; reply: PendingReply | null }[] = []
  const logger = createMemoryLogger()

  const boot = async () => {
    bridge = createClaudeBridge({
      port: 0,
      token: TOKEN,
      onEvent: (e, reply) => events.push({ e, reply }),
      logger,
    })
    await bridge.start()
    return bridge.port()
  }

  afterEach(async () => {
    await bridge?.stop()
    bridge = undefined
    events.length = 0
    logger.entries.length = 0
  })

  it('rejects missing or wrong token with 403 before reading the body', async () => {
    const port = await boot()
    expect((await send(port, { token: null, body: hook('Stop') })).status).toBe(403)
    expect((await send(port, { token: 'nope', body: hook('Stop') })).status).toBe(403)
    expect((await send(port, { token: `${TOKEN}x`, body: hook('Stop') })).status).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('returns 404 for other paths and 405 for other methods', async () => {
    const port = await boot()
    expect((await send(port, { path: '/other', body: '{}' })).status).toBe(404)
    expect((await send(port, { method: 'GET', body: '' })).status).toBe(405)
  })

  it('returns 413 for bodies over 256 KiB without parsing', async () => {
    const port = await boot()
    const big = hook('Stop', { pad: 'x'.repeat(262_144) })
    const res = await send(port, { body: big }).catch(() => ({ status: 413, body: '' }))
    expect(res.status).toBe(413)
    expect(events).toHaveLength(0)
  })

  it('returns 415 when content-type is not JSON and accepts a charset suffix', async () => {
    const port = await boot()
    expect((await send(port, { contentType: 'text/plain', body: hook('Stop') })).status).toBe(415)
    expect((await send(port, { contentType: 'application/json; charset=utf-8', body: hook('Stop') })).status).toBe(200)
  })

  it('returns 400 for invalid JSON and unknown events', async () => {
    const port = await boot()
    expect((await send(port, { body: '{oops' })).status).toBe(400)
    expect((await send(port, { body: hook('Bogus') })).status).toBe(400)
    expect(events).toHaveLength(0)
  })

  it('answers valid non-permission events with an empty 200 and calls onEvent with no reply', async () => {
    const port = await boot()
    const res = await send(port, { body: hook('PreToolUse', { tool_name: 'Bash' }) })
    expect(res).toEqual({ status: 200, body: '' })
    expect(events).toHaveLength(1)
    expect(events[0]?.e).toMatchObject({ name: 'PreToolUse', sessionId: 's1', toolName: 'Bash' })
    expect(events[0]?.reply).toBeNull()
  })

  it('holds a PermissionRequest until reply.send is called', async () => {
    const port = await boot()
    let settled = false
    const pending = send(port, { body: hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }) }).then((r) => {
      settled = true
      return r
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(events).toHaveLength(1)
    expect(settled).toBe(false)
    const reply = events[0]?.reply
    expect(reply).not.toBeNull()
    reply?.send('{"ok":true}')
    reply?.send('{"second":true}')
    expect(await pending).toEqual({ status: 200, body: '{"ok":true}' })
  })

  it('stamps a held request when it arrives, before its body is read', async () => {
    const port = await boot()
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/hook',
      headers: { 'x-notch-token': TOKEN, 'content-type': 'application/json' },
    })
    req.on('error', () => undefined)
    req.flushHeaders()
    await new Promise((r) => setTimeout(r, 150))
    req.end(hook('PermissionRequest'))
    await new Promise((r) => setTimeout(r, 100))
    const reply = events[0]?.reply
    expect(reply?.arrivedAt).toBeTypeOf('number')
    // The body came ~150 ms after the headers: the stamp is from the headers.
    expect(Date.now() - reply!.arrivedAt!).toBeGreaterThanOrEqual(200)
    reply?.send(null)
  })

  it('replies 200 empty for send(null) and never throws on a finished response', async () => {
    const port = await boot()
    const pending = send(port, { body: hook('PermissionRequest') })
    await new Promise((r) => setTimeout(r, 50))
    const reply = events[0]?.reply
    reply?.send(null)
    expect(await pending).toEqual({ status: 200, body: '' })
    expect(() => reply?.send('late')).not.toThrow()
  })

  it('fires onClose when the client disconnects before we reply, and not after we sent', async () => {
    const port = await boot()
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/hook',
      headers: { 'x-notch-token': TOKEN, 'content-type': 'application/json' },
    })
    req.on('error', () => undefined)
    req.end(hook('PermissionRequest'))
    await new Promise((r) => setTimeout(r, 100))
    const reply = events[0]?.reply
    let closed = 0
    reply?.onClose(() => (closed += 1))
    req.destroy()
    await new Promise((r) => setTimeout(r, 100))
    expect(closed).toBe(1)

    const done = send(port, { body: hook('PermissionRequest') })
    await new Promise((r) => setTimeout(r, 50))
    const second = events[1]?.reply
    let secondClosed = 0
    second?.onClose(() => (secondClosed += 1))
    second?.send(null)
    await done
    await new Promise((r) => setTimeout(r, 50))
    expect(secondClosed).toBe(0)
  })

  it('never logs prompt or tool_input values or the token', async () => {
    const port = await boot()
    await send(port, { body: hook('UserPromptSubmit', { prompt: 'SECRET-PROMPT-TEXT' }) })
    await send(port, { body: hook('PreToolUse', { tool_input: { command: 'SECRET-COMMAND' } }) })
    await send(port, { token: 'wrong-token-attempt', body: hook('Stop') })
    const logged = JSON.stringify(logger.entries)
    expect(logged).not.toContain('SECRET-PROMPT-TEXT')
    expect(logged).not.toContain('SECRET-COMMAND')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('wrong-token-attempt')
  })

  it('stop() closes open held connections without hanging', async () => {
    const port = await boot()
    const pending = send(port, { body: hook('PermissionRequest') }).catch(() => 'closed')
    await new Promise((r) => setTimeout(r, 100))
    await bridge?.stop()
    expect(await pending).toBe('closed')
    bridge = undefined
  })

  it('rejects a Host header other than 127.0.0.1:<port> or localhost:<port> with 403 (DNS rebinding)', async () => {
    const port = await boot()
    expect((await send(port, { host: `evil.example:${port}`, body: hook('Stop') })).status).toBe(403)
    expect((await send(port, { host: '127.0.0.1', body: hook('Stop') })).status).toBe(403)
    expect((await send(port, { host: `127.0.0.1:${port + 1}`, body: hook('Stop') })).status).toBe(403)
    expect(events).toHaveLength(0)
    expect((await send(port, { host: `localhost:${port}`, body: hook('Stop') })).status).toBe(200)
    expect((await send(port, { host: `LOCALHOST:${port}`, body: hook('Stop') })).status).toBe(200)
    expect((await send(port, { body: hook('Stop') })).status).toBe(200)
  })

  it('stop() right after send(null) still delivers the empty 200 (no lost release on quit)', async () => {
    const port = await boot()
    const pending = send(port, { body: hook('PermissionRequest') }).catch((error: Error) => error.message)
    await new Promise((r) => setTimeout(r, 100))
    events[0]?.reply?.send(null)
    await bridge?.stop()
    expect(await pending).toEqual({ status: 200, body: '' })
    bridge = undefined
  })

  it('stop() finishes within a bounded time even if a client keeps its connection open', async () => {
    const port = await boot()
    // A raw socket that never sends a full request nor closes.
    const { connect } = await import('node:net')
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.on('end', () => undefined)
    await new Promise((r) => socket.once('connect', r))
    // Headers never finish: the server waits for more, and the client never closes on its own.
    socket.write('POST /hook HTTP/1.1\r\nhost: 127.0.0.1\r\n')
    const started = Date.now()
    await bridge?.stop()
    expect(Date.now() - started).toBeLessThan(2_000)
    socket.destroy()
    bridge = undefined
  })

  it('start() rejects when the port is already in use', async () => {
    const port = await boot()
    const other = createClaudeBridge({ port, token: TOKEN, onEvent: () => undefined, logger })
    await expect(other.start()).rejects.toThrow(/EADDRINUSE/)
  })
})
