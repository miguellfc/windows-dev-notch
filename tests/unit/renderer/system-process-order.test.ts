import { describe, expect, it } from 'vitest'
import { freezeOrder, rowId, sortRows } from '../../../src/renderer/notch/system/process-order'
import type { ProcessRow } from '../../../src/shared/system/schema'

const row = (pid: number, cpuPercent: number | null, privateBytes: number | null = 1): ProcessRow => ({
  pid,
  name: `p${pid}.exe`,
  cpuPercent,
  privateBytes,
  startTime: `t${pid}`,
  killable: true,
})
const pids = (rows: ProcessRow[]) => rows.map((r) => r.pid)

describe('sortRows', () => {
  it('sorts by the chosen order, highest first, unread values last', () => {
    const rows = [row(1, 5, 300), row(2, null, 100), row(3, 50, null)]
    expect(pids(sortRows(rows, 'cpu'))).toEqual([3, 1, 2])
    expect(pids(sortRows(rows, 'ram'))).toEqual([1, 2, 3])
  })
})

describe('freezeOrder', () => {
  it('keeps the frozen order when CPU re-ranks the rows (the confirming row stays put)', () => {
    const shown = [row(1, 50), row(2, 40), row(3, 30)]
    const frozen = shown.map(rowId)
    // Next tick: pid 3 jumps to the top, pid 1 falls to the bottom.
    const next = sortRows([row(1, 1), row(2, 40), row(3, 90)], 'cpu')
    expect(pids(next)).toEqual([3, 2, 1])
    expect(pids(freezeOrder(next, frozen))).toEqual([1, 2, 3])
  })

  it('drops rows that left and appends new ones in their current order', () => {
    const frozen = [row(1, 50), row(2, 40), row(3, 30)].map(rowId)
    const next = sortRows([row(3, 30), row(1, 50), row(9, 99), row(8, 70)], 'cpu')
    expect(pids(freezeOrder(next, frozen))).toEqual([1, 3, 9, 8])
  })

  it('treats a reused pid (new start time) as a new row', () => {
    const frozen = [row(1, 50), row(2, 40)].map(rowId)
    const reused = { ...row(1, 99), startTime: 'other' }
    expect(freezeOrder([reused, row(2, 40)], frozen).map(rowId)).toEqual(['2:t2', '1:other'])
  })
})
