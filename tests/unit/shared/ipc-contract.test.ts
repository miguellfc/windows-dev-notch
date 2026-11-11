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
    expect(contract['notch:pointer'].input.safeParse({ inside: 'yes' }).success).toBe(false)
  })

  it('bounds terminal input and size', () => {
    const input = contract['terminal:input'].input
    expect(input.safeParse({ data: 'dir\r' }).success).toBe(true)
    expect(input.safeParse({ data: '' }).success).toBe(false)
    expect(input.safeParse({ data: 'a'.repeat(65_536) }).success).toBe(true)
    expect(input.safeParse({ data: 'a'.repeat(65_537) }).success).toBe(false)
    expect(input.safeParse({ data: 'x', shell: 'cmd.exe' }).success).toBe(false)

    const resize = contract['terminal:resize'].input
    expect(resize.safeParse({ cols: 80, rows: 24 }).success).toBe(true)
    for (const bad of [{ cols: 1, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 0 }, { cols: 80, rows: 201 }, { cols: 80.5, rows: 24 }]) {
      expect(resize.safeParse(bad).success).toBe(false)
    }
  })

  it('only opens known integrations', () => {
    expect(contract['notch:open-integration'].input.safeParse({ id: 'terminal' }).success).toBe(true)
    expect(contract['notch:open-integration'].input.safeParse({ id: 'browser' }).success).toBe(false)
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

  it('bounds the session id to dismiss', () => {
    const dismiss = contract['claude:dismiss-session'].input
    expect(dismiss.safeParse({ sessionId: 'abc' }).success).toBe(true)
    expect(dismiss.safeParse({ sessionId: '' }).success).toBe(false)
    expect(dismiss.safeParse({ sessionId: 'a'.repeat(257) }).success).toBe(false)
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
      expect(name).toMatch(/^[a-z]+:[a-z-]+$/)
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
