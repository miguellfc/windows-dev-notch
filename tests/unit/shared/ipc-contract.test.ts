import { describe, expect, it, vi } from 'vitest'
import { buildApi } from '../../../src/shared/ipc/build-api'
import { channels, eventChannels } from '../../../src/shared/ipc/channels'
import { contract, eventContract } from '../../../src/shared/ipc/contract'
import { err, ok } from '../../../src/shared/ipc/result'
import { NO_ALERTS, PROCESS_LIMIT } from '../../../src/shared/system/schema'

const channelNames = Object.values(channels).flatMap((group) => Object.values(group))

describe('IPC contract', () => {
  it('defines a schema for every exposed channel and nothing else', () => {
    expect([...channelNames].sort()).toEqual(Object.keys(contract).sort())
  })

  it('defines a payload schema for every event channel', () => {
    expect(Object.values(eventChannels).sort()).toEqual(Object.keys(eventContract).sort())
  })

  it('validates request payloads for the notch channels', () => {
    expect(contract['notch:request'].input.safeParse({ intent: 'toggle' }).success).toBe(true)
    expect(contract['notch:request'].input.safeParse({ intent: 'explode' }).success).toBe(false)
    // Right click pins the thin pill; a left click on it unpins.
    expect(contract['notch:request'].input.safeParse({ intent: 'pin-mini' }).success).toBe(true)
    expect(contract['notch:request'].input.safeParse({ intent: 'unpin-mini' }).success).toBe(true)
    expect(contract['notch:pointer'].input.safeParse({ inside: 'yes' }).success).toBe(false)
  })

  it('only opens known integrations', () => {
    expect(contract['notch:open-integration'].input.safeParse({ id: 'notes' }).success).toBe(true)
    expect(contract['notch:open-integration'].input.safeParse({ id: 'browser' }).success).toBe(false)
    // Terminal is an app now, not an in-notch view.
    expect(contract['notch:open-integration'].input.safeParse({ id: 'terminal' }).success).toBe(false)
  })

  it('opens only the known apps, with no extra keys', () => {
    const input = contract['apps:open'].input
    expect(input.safeParse({ app: 'claude' }).success).toBe(true)
    expect(input.safeParse({ app: 'terminal' }).success).toBe(true)
    expect(input.safeParse({ app: 'notes' }).success).toBe(false)
    expect(input.safeParse({ app: 'claude', url: 'https://example.test' }).success).toBe(false)
    expect(contract['apps:open'].output.safeParse({ ok: true }).success).toBe(true)
  })

  it('decides only on a uuid with allow or deny', () => {
    const decide = contract['claude:decide'].input
    const requestId = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
    expect(decide.safeParse({ requestId, decision: 'allow' }).success).toBe(true)
    expect(decide.safeParse({ requestId, decision: 'deny' }).success).toBe(true)
    expect(decide.safeParse({ requestId, decision: 'always' }).success).toBe(false)
    expect(decide.safeParse({ requestId: 'not-a-uuid', decision: 'allow' }).success).toBe(false)
    expect(decide.safeParse({ requestId, decision: 'allow', rule: 'Bash(*)' }).success).toBe(false)
  })

  it('keeps the Claude state strict so nothing extra (e.g. a token) can ride along', () => {
    const state = { connection: 'connected', hooks: 'installed', sessions: [], pending: [] }
    expect(contract['claude:get-state'].output.safeParse(state).success).toBe(true)
    expect(contract['claude:get-state'].output.safeParse({ ...state, token: 'x' }).success).toBe(false)
    expect(eventContract['claude:state-changed'].safeParse({ ...state, connection: 'maybe' }).success).toBe(false)
    expect(contract['claude:hooks-preview'].output.safeParse({ ok: true, diff: [], next: '{}' }).success).toBe(false)
  })

  it('carries only the known connection error reason', () => {
    const state = { connection: 'error', hooks: 'installed', sessions: [], pending: [] }
    const schema = contract['claude:get-state'].output
    expect(schema.safeParse({ ...state, reason: 'port-in-use' }).success).toBe(true)
    expect(schema.safeParse({ ...state, reason: 'something-else' }).success).toBe(false)
  })

  it('requires the truncation flag and full length on every pending permission', () => {
    const pending = { id: 'a', sessionId: 's', sessionName: 'n', toolName: 'Bash', preview: 'ls', receivedAt: 1 }
    const state = { connection: 'connected', hooks: 'installed', sessions: [] }
    const schema = contract['claude:get-state'].output
    expect(schema.safeParse({ ...state, pending: [pending] }).success).toBe(false)
    expect(schema.safeParse({ ...state, pending: [{ ...pending, previewTruncated: true, previewLength: 3000 }] }).success).toBe(true)
  })

  it('rotations report what happened to the hooks', () => {
    for (const channel of ['claude:rotate-token', 'claude:rotate-port'] as const) {
      const output = contract[channel].output
      expect(output.safeParse({ hooks: 'reinstall-failed' }).success).toBe(true)
      expect(output.safeParse(null).success).toBe(false)
      expect(output.safeParse({ hooks: 'reinstalled', port: 50_001 }).success).toBe(false)
    }
  })

  describe('Claude questions', () => {
    const id = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
    const question = {
      question: '¿Cuál?',
      header: 'Elige',
      multiSelect: false,
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: '' },
      ],
    }
    const view = { id, project: 'my-project', questions: [question], arrivedAt: 1 }

    it('exposes the question channels and event', () => {
      expect(channels.claude).toMatchObject({
        getQuestions: 'claude:get-questions',
        answer: 'claude:answer',
        releaseQuestion: 'claude:release-question',
      })
      expect(eventChannels.claudeQuestions).toBe('claude:questions')
    })

    it('pending questions are strict and never carry the session id', () => {
      for (const schema of [eventContract['claude:questions'], contract['claude:get-questions'].output]) {
        expect(schema.safeParse([view]).success).toBe(true)
        expect(schema.safeParse([]).success).toBe(true)
        expect(schema.safeParse([{ ...view, sessionId: 's' }]).success).toBe(false)
        expect(schema.safeParse([{ ...view, questions: [{ ...question, extra: 1 }] }]).success).toBe(false)
        expect(schema.safeParse([{ ...view, questions: [] }]).success).toBe(false)
        expect(schema.safeParse([{ ...view, questions: [{ ...question, options: [question.options[0]] }] }]).success).toBe(false)
      }
      expect(contract['claude:get-questions'].input.safeParse(undefined).success).toBe(true)
    })

    it('answers carry only positions and free text, and return sent or gone', () => {
      const answer = contract['claude:answer']
      expect(answer.input.safeParse({ id, answers: [{ selected: [0] }] }).success).toBe(true)
      expect(answer.input.safeParse({ id, answers: [{ selected: [], other: 'Otra cosa' }] }).success).toBe(true)
      expect(answer.input.safeParse({ id, answers: [] }).success).toBe(false)
      expect(answer.input.safeParse({ id, answers: [{ selected: [-1] }] }).success).toBe(false)
      expect(answer.input.safeParse({ id, answers: [{ selected: [0], label: 'A' }] }).success).toBe(false)
      expect(answer.input.safeParse({ id, answers: [{ selected: [0] }], questions: [] }).success).toBe(false)
      expect(answer.input.safeParse({ id: '', answers: [{ selected: [0] }] }).success).toBe(false)
      expect(answer.output.safeParse('sent').success).toBe(true)
      expect(answer.output.safeParse('gone').success).toBe(true)
      expect(answer.output.safeParse('invalid').success).toBe(false)
    })

    it('releases a question by id only', () => {
      const release = contract['claude:release-question']
      expect(release.input.safeParse({ id }).success).toBe(true)
      expect(release.input.safeParse({ id: '' }).success).toBe(false)
      expect(release.input.safeParse({ id, answers: [] }).success).toBe(false)
      expect(release.output.safeParse(null).success).toBe(true)
    })
  })

  it('bounds the session id to dismiss', () => {
    const dismiss = contract['claude:dismiss-session'].input
    expect(dismiss.safeParse({ sessionId: 'abc' }).success).toBe(true)
    expect(dismiss.safeParse({ sessionId: '' }).success).toBe(false)
    expect(dismiss.safeParse({ sessionId: 'a'.repeat(257) }).success).toBe(false)
  })

  it('exposes the notes channels and event', () => {
    expect(channels.notes).toEqual({
      list: 'notes:list',
      create: 'notes:create',
      update: 'notes:update',
      pin: 'notes:pin',
      delete: 'notes:delete',
      restore: 'notes:restore',
      copy: 'notes:copy',
    })
    expect(eventChannels.notesChanged).toBe('notes:changed')
  })

  it('validates notes inputs', () => {
    const id = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
    expect(contract['notes:create'].input.safeParse({ text: 'Hola' }).success).toBe(true)
    expect(contract['notes:create'].input.safeParse({ text: '' }).success).toBe(false)
    expect(contract['notes:create'].input.safeParse({ text: 'a', id }).success).toBe(false)
    expect(contract['notes:update'].input.safeParse({ id, text: 'Hola' }).success).toBe(true)
    expect(contract['notes:pin'].input.safeParse({ id, pinned: true }).success).toBe(true)
    expect(contract['notes:pin'].input.safeParse({ id }).success).toBe(false)
    for (const channel of ['notes:delete', 'notes:restore', 'notes:copy'] as const) {
      const input = contract[channel].input
      expect(input.safeParse({ id }).success).toBe(true)
      expect(input.safeParse({ id: 'nope' }).success).toBe(false)
      expect(input.safeParse({ id, text: 'x' }).success).toBe(false)
    }
  })

  it('exposes the reminders channels and events', () => {
    expect(channels.reminders).toEqual({
      list: 'reminders:list',
      create: 'reminders:create',
      update: 'reminders:update',
      snooze: 'reminders:snooze',
      complete: 'reminders:complete',
      delete: 'reminders:delete',
    })
    expect(eventChannels.remindersChanged).toBe('reminders:changed')
    expect(eventChannels.remindersFired).toBe('reminders:fired')
  })

  it('validates reminder ids and inputs', () => {
    const id = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
    for (const channel of ['reminders:snooze', 'reminders:complete', 'reminders:delete'] as const) {
      const input = contract[channel].input
      expect(input.safeParse({ id }).success).toBe(true)
      expect(input.safeParse({ id: 'nope' }).success).toBe(false)
      expect(input.safeParse({ id, text: 'x' }).success).toBe(false)
    }
    const create = contract['reminders:create'].input
    expect(create.safeParse({ input: 'en 30 min revisar PR' }).success).toBe(true)
    expect(create.safeParse({ text: 'Revisar PR', preset: 'tomorrow-9' }).success).toBe(true)
    expect(create.safeParse({ text: 'Revisar PR', preset: 'never' }).success).toBe(false)
    const dueAt = '2026-11-10T15:15:00.000Z'
    expect(create.safeParse({ text: 'Revisar PR', dueAt, repeat: 'none' }).success).toBe(true)
    expect(create.safeParse({ text: 'Revisar PR', dueAt, repeat: 'weekdays' }).success).toBe(true)
    expect(create.safeParse({ text: 'Revisar PR', dueAt, repeat: 'hourly' }).success).toBe(false)
    expect(create.safeParse({ text: 'Revisar PR', dueAt: 'mañana', repeat: 'none' }).success).toBe(false)
    expect(create.safeParse({ text: '', dueAt, repeat: 'none' }).success).toBe(false)
    expect(create.safeParse({ text: 'Revisar PR', dueAt }).success).toBe(false)
    expect(create.safeParse({ text: 'Revisar PR', dueAt, repeat: 'none', preset: '1h' }).success).toBe(false)
    const update = contract['reminders:update'].input
    expect(update.safeParse({ id, repeat: 'daily' }).success).toBe(true)
    expect(update.safeParse({ id }).success).toBe(false)
  })

  it('keeps the reminders list strict and the notice closed', () => {
    const reminder = {
      id: '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f',
      text: 'Revisar PR',
      dueAt: '2026-11-10T10:00:00.000Z',
      repeat: 'none',
      state: 'due',
      createdAt: '2026-11-10T09:00:00.000Z',
    }
    const list = contract['reminders:list'].output
    for (const notice of [null, 'quarantined', 'read-only']) {
      expect(list.safeParse({ reminders: [reminder], notice }).success).toBe(true)
    }
    expect(list.safeParse({ reminders: [reminder], notice: 'other' }).success).toBe(false)
    expect(list.safeParse({ reminders: [reminder] }).success).toBe(false)
    expect(list.safeParse({ reminders: [{ ...reminder, extra: 1 }], notice: null }).success).toBe(false)
    expect(eventContract['reminders:changed'].safeParse({ reminders: [], notice: null }).success).toBe(true)
    expect(eventContract['reminders:fired'].safeParse({ count: 2 }).success).toBe(true)
    expect(eventContract['reminders:fired'].safeParse({ count: 0 }).success).toBe(false)
    expect(eventContract['reminders:fired'].safeParse({ count: 1, text: 'x' }).success).toBe(false)
  })

  it('uses unique, namespaced channel names', () => {
    expect(new Set(channelNames).size).toBe(channelNames.length)
    for (const name of channelNames) {
      // Namespaces may be hyphenated (`code-review:`), never start or end with a hyphen.
      expect(name).toMatch(/^[a-z]+(-[a-z]+)*:[a-z-]+$/)
    }
  })
})

describe('buildApi', () => {
  it('maps each method to an invoke on its channel', async () => {
    const invoke = vi.fn().mockResolvedValue(ok('done'))
    const api = buildApi(invoke)

    await api.settings.update({ language: 'en' })
    await api.settings.get()
    await api.app.getInfo()

    expect(invoke).toHaveBeenNthCalledWith(1, 'settings:update', { language: 'en' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'settings:get', undefined)
    expect(invoke).toHaveBeenNthCalledWith(3, 'app:get-info', undefined)
  })

  it('turns transport failures into an INTERNAL result instead of rejecting', async () => {
    const api = buildApi(vi.fn().mockRejectedValue(new Error('No handler registered')))
    await expect(api.settings.get()).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'IPC call failed' },
    })
  })

  it('subscribes only to known event channels and returns an unsubscribe', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const api = buildApi(vi.fn(), subscribe)
    const listener = vi.fn()

    expect(api.events.on('notch:mode-changed', listener)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('notch:mode-changed', listener)
    expect(() => api.events.on('evil:event' as 'notch:mode-changed', listener)).toThrow(/Unknown event/)
  })

  it('returns a frozen object so the renderer cannot add channels', () => {
    const api = buildApi(vi.fn())
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.settings)).toBe(true)
  })
})

describe('usage contract', () => {
  const summary = {
    days: 3,
    runningHoursAvg: 2.5,
    launches: 4,
    remindersFired: 1,
    remindersMissed: 0,
    remindersCompleted: 1,
    claudeAlerts: 2,
    claudeLatencyMedianMs: 40,
    claudeLatencyP95Ms: null,
    from: '2026-10-28',
    to: '2026-11-10',
  }

  it('accepts only the 7, 14 and 30 day ranges (or none)', () => {
    const input = contract['usage:summary'].input
    for (const days of [7, 14, 30]) expect(input.safeParse({ days }).success).toBe(true)
    expect(input.safeParse({}).success).toBe(true)
    for (const days of [0, 1, 15, 90, '14', 14.5]) expect(input.safeParse({ days }).success).toBe(false)
    expect(input.safeParse({ days: 14, file: 'usage.json' }).success).toBe(false)
  })

  it('keeps the summary strict and counts-only', () => {
    const output = contract['usage:summary'].output
    expect(output.safeParse(summary).success).toBe(true)
    expect(output.safeParse({ ...summary, sessions: ['secret'] }).success).toBe(false)
    expect(output.safeParse({ ...summary, launches: -1 }).success).toBe(false)
    expect(output.safeParse({ ...summary, from: 'yesterday' }).success).toBe(false)
  })
})

describe('system monitor contract', () => {
  const light = { cpuPercent: 12, ram: { usedBytes: 1, totalBytes: 2 }, battery: null, alerts: NO_ALERTS }
  const row = { pid: 42, name: 'node.exe', cpuPercent: 1.5, privateBytes: 1024, startTime: '2026-11-10T09:00:00.000Z', killable: true }

  it('exposes the system channels and events', () => {
    expect(channels.system).toEqual({ view: 'system:view', killProcess: 'system:kill-process' })
    expect(eventChannels.systemMetrics).toBe('system:metrics')
    expect(eventChannels.systemProcesses).toBe('system:processes')
  })

  it('sets the view order to cpu or ram (open/close follows the notch mode)', () => {
    const view = contract['system:view'].input
    expect(view.safeParse({ by: 'cpu' }).success).toBe(true)
    expect(view.safeParse({ by: 'ram' }).success).toBe(true)
    expect(view.safeParse({}).success).toBe(false)
    expect(view.safeParse({ open: true }).success).toBe(false)
    expect(view.safeParse({ open: false, by: 'ram' }).success).toBe(false)
    expect(view.safeParse({ by: 'disk' }).success).toBe(false)
    expect(view.safeParse({ by: 'cpu', path: 'C:/' }).success).toBe(false)
    expect(contract['system:view'].output.safeParse(null).success).toBe(true)
  })

  it('closes by pid and start time only, and returns a known result', () => {
    const kill = contract['system:kill-process']
    expect(kill.input.safeParse({ pid: 42, startTime: row.startTime }).success).toBe(true)
    expect(kill.input.safeParse({ pid: -1, startTime: row.startTime }).success).toBe(false)
    expect(kill.input.safeParse({ pid: 42, startTime: row.startTime, name: 'node.exe' }).success).toBe(false)
    for (const result of ['killed', 'gone', 'denied', 'not-killable']) expect(kill.output.safeParse(result).success).toBe(true)
    expect(kill.output.safeParse('maybe').success).toBe(false)
  })

  it('validates metrics and process events', () => {
    const metrics = eventContract['system:metrics']
    expect(metrics.safeParse({ kind: 'light', ...light }).success).toBe(true)
    expect(metrics.safeParse({ kind: 'full', ...light, disks: [], network: null }).success).toBe(true)
    expect(metrics.safeParse({ kind: 'unavailable' }).success).toBe(true)
    expect(metrics.safeParse({ kind: 'light', ...light, cpuPercent: 101 }).success).toBe(false)
    const rows = eventContract['system:processes']
    expect(rows.safeParse([row]).success).toBe(true)
    expect(rows.safeParse(Array.from({ length: PROCESS_LIMIT }, (_, i) => ({ ...row, pid: i + 1 }))).success).toBe(true)
    expect(rows.safeParse(Array.from({ length: PROCESS_LIMIT + 1 }, (_, i) => ({ ...row, pid: i + 1 }))).success).toBe(false)
    expect(PROCESS_LIMIT).toBe(5)
    expect(rows.safeParse([{ ...row, path: 'C:/x' }]).success).toBe(false)
  })
})

describe('result helpers', () => {
  it('builds success and error results', () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 })
    expect(err('FORBIDDEN', 'nope')).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'nope' } })
  })
})

describe('gmail contract', () => {
  const state = { status: 'ok', account: 'me@x.com', unread: 100, updatedAt: '2026-11-11T10:00:00.000Z', persistent: true, reason: null }
  const message = { id: 'm1', threadId: 't1', from: 'Ana', subject: '', snippet: '', date: '2026-11-11T09:00:00.000Z', unread: true }

  it('exposes the gmail channels and state event', () => {
    expect(channels.gmail).toEqual({
      getState: 'gmail:get-state',
      recent: 'gmail:recent',
      view: 'gmail:view',
      refresh: 'gmail:refresh',
      open: 'gmail:open',
      signIn: 'gmail:sign-in',
      cancelSignIn: 'gmail:cancel-sign-in',
      signOut: 'gmail:sign-out',
      pickClientFile: 'gmail:pick-client-file',
      message: 'gmail:message',
      markRead: 'gmail:mark-read',
      delete: 'gmail:delete',
      openLink: 'gmail:open-link',
      closeMessage: 'gmail:close-message',
    })
    expect(eventChannels.gmailState).toBe('gmail:state')
    expect(eventChannels.gmailNewMail).toBe('gmail:new-mail')
  })

  const detail = {
    id: 'm1',
    threadId: 't1',
    from: 'Ana',
    fromAddress: 'ana@example.com',
    subject: 'Hola',
    date: '2026-11-11T09:00:00.000Z',
    unread: true,
    body: 'Texto',
    truncated: false,
    links: [{ text: 'Web', url: 'https://example.com' }],
    attachments: 1,
  }

  it('reads a message by id only, as strict plain text with http/https links', () => {
    const read = contract['gmail:message']
    expect(read.input.safeParse({ id: 'm1' }).success).toBe(true)
    expect(read.input.safeParse({}).success).toBe(false)
    expect(read.input.safeParse({ id: 'm1', url: 'https://x' }).success).toBe(false)
    expect(read.output.safeParse(detail).success).toBe(true)
    expect(read.output.safeParse({ ...detail, html: '<b>' }).success).toBe(false)
    expect(read.output.safeParse({ ...detail, links: [{ text: 'x', url: 'javascript:alert(1)' }] }).success).toBe(false)
  })

  it('marks as read and deletes by id, answering null', () => {
    for (const channel of ['gmail:mark-read', 'gmail:delete'] as const) {
      expect(contract[channel].input.safeParse({ id: 'm1' }).success).toBe(true)
      expect(contract[channel].input.safeParse({ id: '' }).success).toBe(false)
      expect(contract[channel].input.safeParse({ ids: ['m1'] }).success).toBe(false)
      expect(contract[channel].output.safeParse(null).success).toBe(true)
    }
  })

  it('opens a link by index, never by URL', () => {
    const open = contract['gmail:open-link']
    expect(open.input.safeParse({ id: 'm1', index: 0 }).success).toBe(true)
    expect(open.input.safeParse({ id: 'm1', index: 50 }).success).toBe(false)
    expect(open.input.safeParse({ id: 'm1', index: -1 }).success).toBe(false)
    expect(open.input.safeParse({ id: 'm1', url: 'https://example.com' }).success).toBe(false)
    expect(open.output.safeParse(null).success).toBe(true)
  })

  it('closes the open message with no input', () => {
    const close = contract['gmail:close-message']
    expect(close.input.safeParse(undefined).success).toBe(true)
    expect(close.input.safeParse({ id: 'm1' }).success).toBe(false)
    expect(close.output.safeParse(null).success).toBe(true)
  })

  it('announces new mail with or without sender and subject, nothing else', () => {
    const event = eventContract['gmail:new-mail']
    expect(event.safeParse({ count: 1, id: 'm1', from: 'Ana', subject: 'Hola' }).success).toBe(true)
    expect(event.safeParse({ count: 3, id: 'm1' }).success).toBe(true)
    expect(event.safeParse({ count: 0, id: 'm1' }).success).toBe(false)
    expect(event.safeParse({ count: 1, id: 'm1', snippet: 'x' }).success).toBe(false)
  })

  it('keeps the state strict (no token can ride along) on the channel and the event', () => {
    for (const schema of [contract['gmail:get-state'].output, eventContract['gmail:state']]) {
      expect(schema.safeParse(state).success).toBe(true)
      expect(schema.safeParse({ ...state, refreshToken: 'x' }).success).toBe(false)
      expect(schema.safeParse({ ...state, status: 'connected' }).success).toBe(false)
      expect(schema.safeParse({ ...state, unread: 101 }).success).toBe(false)
    }
  })

  it('returns at most 5 strict messages', () => {
    const recent = contract['gmail:recent'].output
    expect(recent.safeParse(Array.from({ length: 5 }, () => message)).success).toBe(true)
    expect(recent.safeParse(Array.from({ length: 6 }, () => message)).success).toBe(false)
    expect(recent.safeParse([{ ...message, html: '<b>' }]).success).toBe(false)
  })

  it('picks a client file: no input (no path from the renderer), credentials or null out', () => {
    const pick = contract['gmail:pick-client-file']
    expect(pick.input.safeParse(undefined).success).toBe(true)
    expect(pick.input.safeParse({ path: '/x.json' }).success).toBe(false)
    expect(pick.output.safeParse(null).success).toBe(true)
    expect(pick.output.safeParse({ clientId: 'a', clientSecret: 'b' }).success).toBe(true)
    expect(pick.output.safeParse({ clientId: 'a', clientSecret: 'b', extra: 1 }).success).toBe(false)
    expect(pick.output.safeParse({ clientId: '', clientSecret: 'b' }).success).toBe(false)
  })

  it('validates view, open and sign-in', () => {
    expect(contract['gmail:view'].input.safeParse({ open: true }).success).toBe(true)
    expect(contract['gmail:view'].input.safeParse({}).success).toBe(false)
    expect(contract['gmail:open'].input.safeParse({ id: 'm1' }).success).toBe(true)
    expect(contract['gmail:open'].input.safeParse({}).success).toBe(true)
    expect(contract['gmail:open'].input.safeParse({ url: 'https://mail.google.com' }).success).toBe(false)
    for (const result of ['ok', 'cancelled', 'error']) expect(contract['gmail:sign-in'].output.safeParse(result).success).toBe(true)
    expect(contract['gmail:sign-in'].output.safeParse('timeout').success).toBe(false)
    for (const channel of ['gmail:refresh', 'gmail:cancel-sign-in', 'gmail:sign-out', 'gmail:get-state', 'gmail:recent'] as const) {
      expect(contract[channel].input.safeParse(undefined).success).toBe(true)
      expect(contract[channel].input.safeParse({}).success).toBe(false)
    }
  })
})
describe('code review contract', () => {
  const platform = { status: 'ok', account: 'me', unreviewed: 3, updatedAt: '2026-11-13T10:00:00.000Z', persistent: true }
  const state = { github: platform, gitlab: { ...platform, status: 'unconfigured', account: null, unreviewed: null, updatedAt: null } }
  const item = {
    id: 'n1',
    ref: 'o/r#1',
    title: 'T',
    author: 'a',
    updatedAt: '2026-11-13T09:00:00.000Z',
    draft: false,
    review: 'none',
    checks: null,
    conflicts: false,
  }

  it('exposes the code-review channels and events', () => {
    expect(channels.codeReview).toEqual({
      getState: 'code-review:get-state',
      list: 'code-review:list',
      refresh: 'code-review:refresh',
      open: 'code-review:open',
      setToken: 'code-review:set-token',
      clear: 'code-review:clear',
      view: 'code-review:view',
      contributions: 'code-review:contributions',
    })
    expect(eventChannels.codeReviewState).toBe('code-review:state')
    expect(eventChannels.codeReviewAlert).toBe('code-review:alert')
    expect(eventChannels.codeReviewContributionsChanged).toBe('code-review:contributions-changed')
  })

  it('opens and closes the view with a strict boolean', () => {
    const view = contract['code-review:view']
    expect(view.input.safeParse({ open: true }).success).toBe(true)
    expect(view.input.safeParse({ open: false }).success).toBe(true)
    expect(view.input.safeParse({}).success).toBe(false)
    expect(view.input.safeParse({ open: 'yes' }).success).toBe(false)
    expect(view.input.safeParse({ open: true, platform: 'github' }).success).toBe(false)
    expect(view.output.safeParse(null).success).toBe(true)
  })

  it('returns a strict contribution summary (or null) with the error flag, by platform', () => {
    const contributions = contract['code-review:contributions']
    const totals = { commits: 1, opened: 0, merged: 0, reviews: 2 }
    const day = (date: string) => ({ date, count: 0, level: 0, inMonth: true, future: false })
    const summary = {
      month: '2026-11',
      weeks: Array.from({ length: 5 }, (_, w) => Array.from({ length: 7 }, (__, d) => day(`2026-11-${String(((w * 7 + d) % 28) + 1).padStart(2, '0')}`))),
      monthTotal: 3,
      activeDays: 1,
      today: totals,
      week: totals,
      monthTotals: totals,
      partial: false,
      restricted: false,
      updatedAt: '2026-11-13T10:00:00.000Z',
    }
    expect(contributions.input.safeParse({ platform: 'gitlab' }).success).toBe(true)
    expect(contributions.input.safeParse({ platform: 'bitbucket' }).success).toBe(false)
    expect(contributions.input.safeParse({}).success).toBe(false)
    expect(contributions.output.safeParse({ summary: null, error: false }).success).toBe(true)
    expect(contributions.output.safeParse({ summary, error: true }).success).toBe(true)
    expect(contributions.output.safeParse(null).success).toBe(false)
    expect(contributions.output.safeParse(summary).success).toBe(false)
    expect(contributions.output.safeParse({ summary: null }).success).toBe(false)
    expect(contributions.output.safeParse({ summary: { ...summary, repo: 'acme/secret' }, error: false }).success).toBe(false)
    expect(contributions.output.safeParse({ summary, error: false, repo: 'acme/secret' }).success).toBe(false)
  })

  it('announces contribution changes by platform and error flag only', () => {
    const changed = eventContract['code-review:contributions-changed']
    expect(changed.safeParse({ platform: 'github', error: false }).success).toBe(true)
    expect(changed.safeParse({ platform: 'gitlab', error: true }).success).toBe(true)
    expect(changed.safeParse({ platform: 'github' }).success).toBe(false)
    expect(changed.safeParse({ platform: 'github', error: false, repo: 'acme/secret' }).success).toBe(false)
  })

  it('keeps the state strict (no token can ride along) on the channel and the event', () => {
    for (const schema of [contract['code-review:get-state'].output, eventContract['code-review:state']]) {
      expect(schema.safeParse(state).success).toBe(true)
      expect(schema.safeParse({ ...state, github: { ...platform, token: 'x' } }).success).toBe(false)
      expect(schema.safeParse({ ...state, github: { ...platform, unreviewed: 101 } }).success).toBe(false)
      expect(schema.safeParse({ ...state, github: { ...platform, status: 'connected' } }).success).toBe(false)
    }
  })

  it('lists at most 20 strict items per list, without URLs', () => {
    const list = contract['code-review:list']
    expect(list.input.safeParse({ platform: 'gitlab' }).success).toBe(true)
    expect(list.input.safeParse({ platform: 'bitbucket' }).success).toBe(false)
    expect(list.output.safeParse({ toReview: Array.from({ length: 20 }, () => item), mine: [] }).success).toBe(true)
    expect(list.output.safeParse({ toReview: Array.from({ length: 21 }, () => item), mine: [] }).success).toBe(false)
    expect(list.output.safeParse({ toReview: [{ ...item, url: 'https://github.com/o/r/pull/1' }], mine: [] }).success).toBe(false)
  })

  it('opens by platform and id, never by URL', () => {
    const open = contract['code-review:open']
    expect(open.input.safeParse({ platform: 'github', id: 'n1' }).success).toBe(true)
    expect(open.input.safeParse({ platform: 'github', id: '' }).success).toBe(false)
    expect(open.input.safeParse({ platform: 'github', id: 'n1', url: 'https://github.com' }).success).toBe(false)
    expect(open.output.safeParse(null).success).toBe(true)
  })

  it('takes a bounded token and never returns it', () => {
    const set = contract['code-review:set-token']
    expect(set.input.safeParse({ platform: 'github', token: 't' }).success).toBe(true)
    expect(set.input.safeParse({ platform: 'gitlab', token: 't', url: 'https://gitlab.example.test' }).success).toBe(true)
    expect(set.input.safeParse({ platform: 'github', token: '' }).success).toBe(false)
    expect(set.input.safeParse({ platform: 'github', token: 'x'.repeat(256) }).success).toBe(false)
    expect(set.output.safeParse({ ok: true, account: 'me' }).success).toBe(true)
    expect(set.output.safeParse({ ok: false, reason: 'url' }).success).toBe(true)
    expect(set.output.safeParse({ ok: false, reason: 'timeout' }).success).toBe(false)
    expect(set.output.safeParse({ ok: true, account: 'me', token: 't' }).success).toBe(false)
  })

  it('clears and refreshes with strict inputs', () => {
    expect(contract['code-review:clear'].input.safeParse({ platform: 'github' }).success).toBe(true)
    expect(contract['code-review:clear'].input.safeParse({}).success).toBe(false)
    for (const channel of ['code-review:refresh', 'code-review:get-state'] as const) {
      expect(contract[channel].input.safeParse(undefined).success).toBe(true)
      expect(contract[channel].input.safeParse({}).success).toBe(false)
    }
  })

  it('announces first reviews with a count, and kind/ref/title only optionally', () => {
    const alert = eventContract['code-review:alert']
    expect(alert.safeParse({ platform: 'github', count: 1, kind: 'approved', ref: 'o/r#1', title: 'T' }).success).toBe(true)
    expect(alert.safeParse({ platform: 'gitlab', count: 3 }).success).toBe(true)
    expect(alert.safeParse({ platform: 'gitlab', count: 0 }).success).toBe(false)
    expect(alert.safeParse({ platform: 'github', count: 1, url: 'https://github.com' }).success).toBe(false)
  })
})

describe('opening the Control Center on a page', () => {
  it('opens on the default page without input, or on a known page', () => {
    const input = contract['app:open-control-center'].input
    expect(input.safeParse(undefined).success).toBe(true)
    expect(input.safeParse({ page: 'gmail' }).success).toBe(true)
    expect(input.safeParse({ page: 'nowhere' }).success).toBe(false)
    expect(input.safeParse({ page: 'gmail', url: 'https://x' }).success).toBe(false)
  })

  it('has no page event: the page travels in the Control Center URL hash', () => {
    expect(Object.values(eventChannels)).not.toContain('control-center:page')
  })

  it('lists gmail as a notch mode', () => {
    expect(contract['notch:get-mode'].output.safeParse('gmail').success).toBe(true)
    expect(contract['notch:open-integration'].input.safeParse({ id: 'gmail' }).success).toBe(true)
  })
})

describe('code review in the notch contract', () => {
  it('lists reviews as a notch mode and an integration', () => {
    expect(contract['notch:get-mode'].output.safeParse('reviews').success).toBe(true)
    expect(contract['notch:open-integration'].input.safeParse({ id: 'reviews' }).success).toBe(true)
  })

  it('tells the notch whether the alert is the first-review alert, as a boolean', () => {
    expect(eventChannels.notchReviewAlert).toBe('notch:review-alert')
    expect(eventContract['notch:review-alert'].safeParse(true).success).toBe(true)
    expect(eventContract['notch:review-alert'].safeParse('github').success).toBe(false)
  })

  it('lets the notch open the code-review page of the Control Center', () => {
    expect(contract['app:open-control-center'].input.safeParse({ page: 'code-review' }).success).toBe(true)
  })
})
