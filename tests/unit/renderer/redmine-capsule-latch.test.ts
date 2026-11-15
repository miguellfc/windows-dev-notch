import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_REDMINE, nextRedmineBlock, type RedmineLatch } from '../../../src/renderer/notch/system/capsule-latch'
import type { RedmineState, RedmineStatus } from '../../../src/shared/redmine/schema'

const reading = (status: RedmineStatus, todayHours: number | null): RedmineState => ({
  status,
  account: 'someone',
  todayHours,
  updatedAt: 1,
  persistent: true,
})
const feed = (states: RedmineState[], from: RedmineLatch = EMPTY_REDMINE): RedmineLatch => states.reduce(nextRedmineBlock, from)

describe('nextRedmineBlock', () => {
  it('starts hidden and shows today with the first reading in a live session, 0 included', () => {
    expect(EMPTY_REDMINE.hours).toBeNull()
    expect(feed([reading('ok', 5.5)]).hours).toBe(5.5)
    expect(feed([reading('offline', 2)]).hours).toBe(2)
    expect(feed([reading('ok', 0)]).hours).toBe(0)
  })

  it('stays hidden while unconfigured, signed out or without a first reading', () => {
    expect(feed([reading('unconfigured', 3)]).hours).toBeNull()
    expect(feed([reading('auth-error', 3)]).hours).toBeNull()
    expect(feed([reading('ok', null)]).hours).toBeNull()
  })

  it('follows each new value at once', () => {
    expect(feed([reading('ok', 2), reading('ok', 5.25)]).hours).toBe(5.25)
  })

  it('hides at once when the session ends', () => {
    expect(feed([reading('ok', 5), reading('auth-error', 5)])).toEqual(EMPTY_REDMINE)
    expect(feed([reading('ok', 5), reading('unconfigured', null)])).toEqual(EMPTY_REDMINE)
  })

  it('keeps the last value through readings without data and gives up after CAPSULE_MISSES in a row', () => {
    const misses = Array.from({ length: CAPSULE_MISSES - 1 }, () => reading('ok', null))
    const kept = feed([reading('ok', 5), ...misses])
    expect(kept.hours).toBe(5)
    expect(feed([reading('ok', 5), ...misses, reading('ok', null)])).toEqual(EMPTY_REDMINE)
  })

  it("offline without today's hours (the last reading is from another day) hides at once", () => {
    expect(feed([reading('ok', 5), reading('offline', null)])).toEqual(EMPTY_REDMINE)
    expect(feed([reading('offline', 5), reading('offline', null)])).toEqual(EMPTY_REDMINE)
  })

  it('a reading with data resets the run of misses', () => {
    const misses = Array.from({ length: CAPSULE_MISSES - 1 }, () => reading('ok', null))
    const latch = feed([reading('ok', 5), ...misses, reading('ok', 6), ...misses])
    expect(latch.hours).toBe(6)
  })

  it('returns the same object when nothing changed', () => {
    const first = feed([reading('ok', 5)])
    expect(nextRedmineBlock(first, reading('ok', 5))).toBe(first)
  })
})
