import { describe, expect, it } from 'vitest'
import { channels, eventChannels } from '../../../src/shared/ipc/channels'
import { contract, eventContract, notchModeSchema } from '../../../src/shared/ipc/contract'
import { workLogEntryViewSchema, workLogSnapshotSchema, workLogSubtaskViewSchema } from '../../../src/shared/work-log/schema'
import { createDefaultSettings, settingsSchema } from '../../../src/shared/settings/schema'

const done = { title: 'Arreglar el login', status: 'done', claudeMs: 600_000, totalMs: 900_000 } as const
const pending = { title: 'Añadir pruebas', status: 'pending', claudeMs: null, totalMs: null } as const

const entry = {
  sessionId: 's-1',
  accountId: 'claude',
  project: 'windows-dev-notch',
  status: 'ready',
  invoiced: false,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_900_000,
  claudeMs: 600_000,
  totalMs: 900_000,
  live: null,
  title: 'Arreglar el login',
  subtasks: [done, pending],
} as const

describe('work log schemas', () => {
  it('accepts a ready entry with a done and a pending subtask', () => {
    expect(workLogEntryViewSchema.safeParse(entry).success).toBe(true)
    expect(workLogSnapshotSchema.safeParse({ entries: [entry], idlePauseMs: 1_800_000 }).success).toBe(true)
  })

  it('accepts live data on a running entry', () => {
    const running = { ...entry, status: 'running', endedAt: null, live: { lastEventAt: 1_700_000_800_000, excessMs: 0, turnOpen: true } }
    expect(workLogEntryViewSchema.safeParse(running).success).toBe(true)
  })

  it('rejects null durations on a done subtask and unknown values', () => {
    expect(workLogSubtaskViewSchema.safeParse({ ...done, totalMs: null }).success).toBe(false)
    expect(workLogSubtaskViewSchema.safeParse({ ...done, claudeMs: null }).success).toBe(false)
    expect(workLogSubtaskViewSchema.safeParse({ ...pending, claudeMs: 1 }).success).toBe(true)
    expect(workLogSubtaskViewSchema.safeParse({ ...done, status: 'skipped' }).success).toBe(false)
    expect(workLogSubtaskViewSchema.safeParse({ ...done, title: '' }).success).toBe(false)
    expect(workLogSubtaskViewSchema.safeParse({ ...done, title: 'a'.repeat(301) }).success).toBe(false)
    expect(workLogEntryViewSchema.safeParse({ ...entry, status: 'sleeping' }).success).toBe(false)
    expect(workLogEntryViewSchema.safeParse({ ...entry, extra: 1 }).success).toBe(false)
  })

  it('rejects idlePauseMinutes of 4 and 241 in the settings', () => {
    for (const idlePauseMinutes of [4, 241]) {
      expect(settingsSchema.safeParse({ ...createDefaultSettings('es'), workLog: { accountId: null, idlePauseMinutes } }).success).toBe(false)
    }
  })
})

describe('work log contract', () => {
  it('exposes the channels and the event', () => {
    expect(channels.workLog).toEqual({
      list: 'work-log:list',
      setInvoiced: 'work-log:set-invoiced',
      delete: 'work-log:delete',
      restore: 'work-log:restore',
      copy: 'work-log:copy',
      summarize: 'work-log:summarize',
      claudeAvailable: 'work-log:claude-available',
    })
    expect(eventChannels.workLogChanged).toBe('work-log:changed')
    expect(eventContract['work-log:changed']).toBe(workLogSnapshotSchema)
  })

  it('validates the inputs', () => {
    expect(contract['work-log:set-invoiced'].input.safeParse({ sessionId: 's-1', invoiced: true }).success).toBe(true)
    expect(contract['work-log:set-invoiced'].input.safeParse({ sessionId: 's-1' }).success).toBe(false)
    expect(contract['work-log:copy'].input.safeParse({ sessionId: 's-1' }).success).toBe(true)
    expect(contract['work-log:copy'].input.safeParse({ sessionId: 's-1', subtask: 0 }).success).toBe(true)
    expect(contract['work-log:copy'].input.safeParse({ sessionId: 's-1', subtask: -1 }).success).toBe(false)
    for (const channel of ['work-log:delete', 'work-log:restore', 'work-log:summarize'] as const) {
      expect(contract[channel].input.safeParse({ sessionId: 's-1' }).success, channel).toBe(true)
      expect(contract[channel].input.safeParse({ sessionId: '' }).success, channel).toBe(false)
    }
    expect(contract['work-log:claude-available'].output.safeParse({ found: true }).success).toBe(true)
    expect(contract['work-log:claude-available'].output.safeParse({}).success).toBe(false)
  })

  it('has a work log notch mode and view', () => {
    expect(notchModeSchema.safeParse('workLog').success).toBe(true)
    expect(contract['notch:open-integration'].input.safeParse({ id: 'workLog' }).success).toBe(true)
  })
})
