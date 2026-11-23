import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roundToMinutes } from '../../../src/shared/work-log/rounding'

interface RoundingCase {
  name: string
  values: number[]
  targetMs: number
  expected: number[]
}

/** Shared with `src-tauri/src/work_log/rounding.rs`: both sides must give the same minutes. */
const { cases } = JSON.parse(readFileSync(resolve(__dirname, '../../parity/work-log-rounding.json'), 'utf8')) as { cases: RoundingCase[] }

describe('roundToMinutes', () => {
  it('has shared cases', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$name', ({ values, targetMs, expected }) => {
    expect(roundToMinutes(values, targetMs)).toEqual(expected)
  })
})
