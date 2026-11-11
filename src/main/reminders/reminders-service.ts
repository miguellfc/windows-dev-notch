import {
  REMINDERS_ACTIVE_MAX,
  REMINDER_DONE_MESSAGE,
  REMINDER_PAST_MESSAGE,
  reminderSchema,
  type CreateReminderInput,
  type Reminder,
  type UpdateReminderInput,
} from '../../shared/reminders/schema'
import { parseReminder } from '../../shared/reminders/parse'
import { nextOccurrence, presetDueAt } from '../../shared/reminders/time'
import { ExposedIpcError } from '../ipc/errors'
import type { RemindersStore } from './reminders-store'

export interface RemindersServiceOptions {
  store: Pick<RemindersStore, 'all' | 'write'>
  now: () => Date
  newId: () => string
  snoozeMinutes: () => number
  onChange: () => void
}

export interface RemindersService {
  list(): Reminder[]
  create(input: CreateReminderInput): Promise<Reminder>
  update(input: UpdateReminderInput): Promise<Reminder>
  snooze(id: string): Promise<Reminder>
  complete(id: string): Promise<Reminder>
  remove(id: string): Promise<void>
  markDue(): Promise<Reminder[]>
  markMissedOnStart(): Promise<Reminder[]>
  purgeDone(): Promise<void>
  nextDueAt(): Date | null
  attentionCount(): number
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const DONE_RETENTION_MS = 7 * DAY_MS
/** Safety cap when walking occurrences forward (about 270 years of daily repeats). */
const MAX_ROLL_STEPS = 100_000

const invalid = (message: string): ExposedIpcError => new ExposedIpcError('INVALID_INPUT', message)
const notFound = (): ExposedIpcError => new ExposedIpcError('NOT_FOUND', 'Reminder not found')

const ms = (iso: string): number => new Date(iso).getTime()

const pad = (n: number): string => String(n).padStart(2, '0')
const localHHmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** Strips `localTime` (and nothing else) from a reminder. */
const withoutLocalTime = (r: Reminder): Reminder => {
  const copy = { ...r }
  delete copy.localTime
  return copy
}

/** Latest occurrence of a repeating reminder that is <= `now`, starting from its current dueAt. */
function latestOccurrenceUpTo(r: Reminder, now: Date): Date {
  let current = new Date(r.dueAt)
  if (r.repeat === 'none' || r.localTime === undefined) return current
  for (let i = 0; i < MAX_ROLL_STEPS; i++) {
    const next = nextOccurrence(r.repeat, r.localTime, current)
    if (next.getTime() > now.getTime()) break
    current = next
  }
  return current
}

/** A done reminder completed before `cutoff` (ms): purged at startup and hidden from list(). */
const isExpiredDone = (r: Reminder, cutoff: number): boolean =>
  r.state === 'done' && r.completedAt !== undefined && ms(r.completedAt) < cutoff

/**
 * A repeating reminder left `due`/`missed` whose following occurrence has already arrived: its
 * current dueAt is stale and should roll forward to the latest occurrence.
 */
const isStaleRepeating = (r: Reminder, at: Date): boolean =>
  (r.state === 'due' || r.state === 'missed') &&
  r.repeat !== 'none' &&
  r.localTime !== undefined &&
  nextOccurrence(r.repeat, r.localTime, new Date(r.dueAt)).getTime() <= at.getTime()

type Plan = { next: Reminder[]; changed: string[] }

export const createRemindersService = ({
  store,
  now,
  newId,
  snoozeMinutes,
  onChange,
}: RemindersServiceOptions): RemindersService => {
  let chain: Promise<unknown> = Promise.resolve()

  /**
   * Runs one mutation as an exclusive unit (snapshot, compute, validate, write), so concurrent
   * operations never build on a stale snapshot. `plan` returns null for a no-op, otherwise the
   * full next list plus the ids of the reminders it touched. Resolves with the validated touched
   * reminders (empty for removals). Every touched reminder passes through `reminderSchema` here.
   */
  const mutate = (plan: (all: readonly Reminder[]) => Plan | null): Promise<Reminder[]> => {
    const run = chain.then(async () => {
      const planned = plan(store.all())
      if (!planned) return []
      const touched = new Set(planned.changed)
      const next = planned.next.map((r) => {
        if (!touched.has(r.id)) return r
        const parsed = reminderSchema.safeParse(r)
        if (!parsed.success) throw invalid('Invalid reminder')
        return parsed.data
      })
      await store.write(next)
      onChange()
      return next.filter((r) => touched.has(r.id))
    })
    chain = run.catch(() => undefined)
    return run
  }

  const findIn = (all: readonly Reminder[], id: string): Reminder => {
    const found = all.find((r) => r.id === id)
    if (!found) throw notFound()
    return found
  }

  const single = (all: readonly Reminder[], updated: Reminder): Plan => ({
    next: all.map((r) => (r.id === updated.id ? updated : r)),
    changed: [updated.id],
  })

  return {
    list: () => {
      // Done reminders older than the retention window are hidden even before the startup purge
      // removes them from disk (spec: reminders:list excludes them).
      const cutoff = now().getTime() - DONE_RETENTION_MS
      return store
        .all()
        .filter((r) => !isExpiredDone(r, cutoff))
        .sort((a, b) => ms(a.dueAt) - ms(b.dueAt))
    },

    async create(input) {
      const at = now()
      let fields: Pick<Reminder, 'text' | 'repeat' | 'localTime'> & { dueAt: Date }
      if ('input' in input) {
        const parsed = parseReminder(input.input, at)
        if ('error' in parsed) throw invalid(parsed.error)
        fields = parsed
      } else if ('preset' in input) {
        fields = { text: input.text, dueAt: presetDueAt(input.preset, at), repeat: 'none' }
      } else if (input.repeat === 'none') {
        if (ms(input.dueAt) <= at.getTime()) throw invalid(REMINDER_PAST_MESSAGE)
        fields = { text: input.text, dueAt: new Date(input.dueAt), repeat: 'none' }
      } else {
        // Repeating: only the wall-clock time matters; the first occurrence is the next one.
        const localTime = localHHmm(new Date(input.dueAt))
        fields = { text: input.text, dueAt: nextOccurrence(input.repeat, localTime, at), repeat: input.repeat, localTime }
      }
      const [created] = await mutate((all) => {
        if (all.filter((r) => r.state !== 'done').length >= REMINDERS_ACTIVE_MAX) throw invalid('limit')
        const fresh: Reminder = {
          id: newId(),
          text: fields.text,
          dueAt: fields.dueAt.toISOString(),
          repeat: fields.repeat,
          ...(fields.localTime !== undefined ? { localTime: fields.localTime } : {}),
          state: 'pending',
          createdAt: at.toISOString(),
        }
        return { next: [...all, fresh], changed: [fresh.id] }
      })
      return created!
    },

    async update(input) {
      const [saved] = await mutate((all) => {
        const current = findIn(all, input.id)
        if (current.state === 'done') throw invalid(REMINDER_DONE_MESSAGE)
        const at = now()

        let next: Reminder = { ...current }
        if (input.text !== undefined) next.text = input.text
        if (input.dueAt !== undefined) {
          if (ms(input.dueAt) <= at.getTime()) throw invalid(REMINDER_PAST_MESSAGE)
          next.dueAt = new Date(input.dueAt).toISOString()
          if (next.state === 'due' || next.state === 'missed') next.state = 'pending'
        }
        if (input.repeat !== undefined) next.repeat = input.repeat

        const repeatChanged = next.repeat !== current.repeat
        const dueChanged = next.dueAt !== current.dueAt
        if (next.repeat === 'none') {
          next = withoutLocalTime(next)
        } else if (repeatChanged || dueChanged) {
          next.localTime = localHHmm(new Date(next.dueAt))
        }
        return single(all, next)
      })
      return saved!
    },

    async snooze(id) {
      const [saved] = await mutate((all) => {
        const current = findIn(all, id)
        if (current.state === 'done') throw invalid(REMINDER_DONE_MESSAGE)
        return single(all, {
          ...current,
          state: 'pending',
          dueAt: new Date(now().getTime() + snoozeMinutes() * MINUTE_MS).toISOString(),
        })
      })
      return saved!
    },

    async complete(id) {
      const [saved] = await mutate((all) => {
        const current = findIn(all, id)
        if (current.state === 'done') throw invalid(REMINDER_DONE_MESSAGE)
        const at = now()
        if (current.repeat === 'none' || current.localTime === undefined) {
          return single(all, { ...current, state: 'done', completedAt: at.toISOString() })
        }
        // Count from the later of now and the current dueAt: completing an occurrence early
        // skips to the following one instead of re-arming the same occurrence.
        const from = new Date(Math.max(at.getTime(), ms(current.dueAt)))
        return single(all, {
          ...current,
          state: 'pending',
          dueAt: nextOccurrence(current.repeat, current.localTime, from).toISOString(),
        })
      })
      return saved!
    },

    async remove(id) {
      await mutate((all) => {
        findIn(all, id)
        return { next: all.filter((r) => r.id !== id), changed: [] }
      })
    },

    markDue() {
      return mutate((all) => {
        const at = now()
        const changed: string[] = []
        const next = all.map((r) => {
          const overduePending = r.state === 'pending' && ms(r.dueAt) <= at.getTime()
          const staleRepeating = isStaleRepeating(r, at)
          if (!overduePending && !staleRepeating) return r
          changed.push(r.id)
          // Repeating reminders jump to the latest occurrence so one miss never fires twice.
          return { ...r, state: 'due' as const, dueAt: latestOccurrenceUpTo(r, at).toISOString() }
        })
        return changed.length === 0 ? null : { next, changed }
      })
    },

    markMissedOnStart() {
      return mutate((all) => {
        const at = now()
        const changed: string[] = []
        const next = all.map((r) => {
          const overduePending = r.state === 'pending' && ms(r.dueAt) <= at.getTime()
          // A repeating reminder left due/missed by the last session whose next occurrence has
          // also passed is reported here, once, instead of firing later as a separate toast.
          if (!overduePending && !isStaleRepeating(r, at)) return r
          changed.push(r.id)
          return { ...r, state: 'missed' as const, dueAt: latestOccurrenceUpTo(r, at).toISOString() }
        })
        return changed.length === 0 ? null : { next, changed }
      })
    },

    async purgeDone() {
      await mutate((all) => {
        const cutoff = now().getTime() - DONE_RETENTION_MS
        const kept = all.filter((r) => !isExpiredDone(r, cutoff))
        return kept.length === all.length ? null : { next: kept, changed: [] }
      })
    },

    nextDueAt() {
      let min: number | null = null
      for (const r of store.all()) {
        if (r.state !== 'pending') continue
        const t = ms(r.dueAt)
        if (min === null || t < min) min = t
      }
      return min === null ? null : new Date(min)
    },

    attentionCount: () => store.all().filter((r) => r.state === 'due' || r.state === 'missed').length,
  }
}
