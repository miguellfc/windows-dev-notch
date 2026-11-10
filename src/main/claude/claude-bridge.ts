import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { parseHookEvent, type HookEvent } from '../../shared/claude/hook-events'
import type { Logger } from '../services/logger'
import type { PendingReply } from './permission-broker'

export const MAX_BODY_BYTES = 262_144
const TOKEN_HEADER = 'x-notch-token'
/** How long stop() lets pending replies (e.g. releaseAll's empty 200s) flush before destroying sockets. */
export const STOP_GRACE_MS = 500

export type ClaudeBridgeOptions = {
  port: number
  token: string
  onEvent: (e: HookEvent, reply: PendingReply | null) => void
  logger: Logger
}

export type ClaudeBridge = {
  start(): Promise<void>
  stop(): Promise<void>
  /** Actual listening port (differs from the option when 0 was requested). */
  port(): number
}

const tokenMatches = (expected: Buffer, received: string | string[] | undefined): boolean => {
  if (typeof received !== 'string') return false
  const candidate = Buffer.from(received, 'utf8')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/** Only our own loopback names: a DNS-rebound page would send its own host name. */
const hostMatches = (host: string | undefined, port: number): boolean => {
  const value = host?.toLowerCase()
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`
}

const isJson = (contentType: string | undefined): boolean =>
  /^application\/json\s*(;|$)/i.test(contentType ?? '')

const createReply = (res: ServerResponse): PendingReply => {
  let sent = false
  return {
    send(body) {
      if (sent) return
      sent = true
      try {
        if (res.writableEnded || res.destroyed) return
        if (body === null) {
          res.writeHead(200)
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
        }
      } catch {
        // The peer may be gone; a held reply must never throw into the broker.
      }
    },
    onClose(cb) {
      res.on('close', () => {
        if (!sent) cb()
      })
    },
  }
}

export const createClaudeBridge = (options: ClaudeBridgeOptions): ClaudeBridge => {
  const log = options.logger.child('claude-bridge')
  const expectedToken = Buffer.from(options.token, 'utf8')
  const sockets = new Set<Socket>()
  let listeningPort = options.port

  const finish = (res: ServerResponse, method: string, path: string, status: number, event?: string): void => {
    try {
      res.writeHead(status, { connection: 'close' })
      res.end()
    } catch {
      // ignore
    }
    log.info('hook request', event === undefined ? { method, path, status } : { method, path, status, event })
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? ''
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!hostMatches(req.headers.host, listeningPort)) return finish(res, method, path, 403)
    if (!tokenMatches(expectedToken, req.headers[TOKEN_HEADER])) return finish(res, method, path, 403)
    if (path !== '/hook') return finish(res, method, path, 404)
    if (method !== 'POST') return finish(res, method, path, 405)
    if (!isJson(req.headers['content-type'])) return finish(res, method, path, 415)

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return finish(res, method, path, 413)

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        chunks.length = 0
        finish(res, method, path, 413)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => undefined)
    req.on('end', () => {
      if (aborted) return
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return finish(res, method, path, 400)
      }
      const event = parseHookEvent(parsed)
      if (!event) return finish(res, method, path, 400)

      if (event.name === 'PermissionRequest') {
        log.info('hook request', { method, path, status: 'held', event: event.name })
        deliver(event, createReply(res))
        return
      }
      finish(res, method, path, 200, event.name)
      deliver(event, null)
    })
  }

  const deliver = (event: HookEvent, reply: PendingReply | null): void => {
    try {
      options.onEvent(event, reply)
    } catch (error) {
      log.error('onEvent failed', { event: event.name, error })
    }
  }

  const server: Server = createServer(handle)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(options.port, '127.0.0.1', () => {
          server.off('error', onError)
          const address = server.address()
          if (address && typeof address === 'object') listeningPort = address.port
          // Runtime errors after start must not crash the main process.
          server.on('error', (error) => log.error('bridge server error', { error }))
          log.info('bridge listening', { port: listeningPort })
          resolve()
        })
      }),

    // Ends sockets gracefully so replies already written (releaseAll's empty 200s) reach Claude;
    // whatever is still open after STOP_GRACE_MS is destroyed, so stop() always completes.
    stop: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
          finish()
        }, STOP_GRACE_MS)
        server.close(() => finish())
        for (const socket of sockets) socket.end()
      }),

    port: () => listeningPort,
  }
}
