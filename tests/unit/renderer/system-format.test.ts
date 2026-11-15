import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatPercent, formatRate } from '../../../src/renderer/notch/system/format'

// Intl separates the number and the unit with a no-break space (U+00A0).
const nb = ' '

describe('formatPercent', () => {
  it('rounds to a whole percent in each language', () => {
    expect(formatPercent(34.4, 'es')).toBe(`34${nb}%`)
    expect(formatPercent(34.6, 'en')).toBe('35%')
    expect(formatPercent(0, 'es')).toBe(`0${nb}%`)
    expect(formatPercent(100, 'en')).toBe('100%')
  })

  it('shows a dash when there is no value', () => {
    expect(formatPercent(null, 'es')).toBe('—')
    expect(formatPercent(null, 'en')).toBe('—')
  })
})

describe('formatBytes', () => {
  const MB = 1024 ** 2
  const GB = 1024 ** 3

  it('uses MB below 1 GB, with one decimal below 10', () => {
    expect(formatBytes(512 * MB, 'es')).toBe(`512${nb}MB`)
    expect(formatBytes(8.44 * MB, 'es')).toBe(`8,4${nb}MB`)
    expect(formatBytes(8.44 * MB, 'en')).toBe(`8.4${nb}MB`)
    expect(formatBytes(0, 'en')).toBe(`0${nb}MB`)
  })

  it('uses GB from 1 GB, with one decimal below 10', () => {
    expect(formatBytes(2.5 * GB, 'es')).toBe(`2,5${nb}GB`)
    expect(formatBytes(2.5 * GB, 'en')).toBe(`2.5${nb}GB`)
    expect(formatBytes(15.7 * GB, 'en')).toBe(`16${nb}GB`)
    expect(formatBytes(1023.9 * GB, 'en')).toBe(`1,024${nb}GB`)
  })

  it('drops a trailing zero decimal', () => {
    expect(formatBytes(4 * GB, 'es')).toBe(`4${nb}GB`)
  })
})

describe('formatRate', () => {
  const KB = 1024
  const MB = 1024 ** 2

  it('uses KB/s below 1 MB/s, with one decimal below 10', () => {
    expect(formatRate(0, 'es')).toBe(`0${nb}KB/s`)
    expect(formatRate(3.25 * KB, 'es')).toBe(`3,3${nb}KB/s`)
    expect(formatRate(340 * KB, 'en')).toBe(`340${nb}KB/s`)
  })

  it('uses MB/s from 1 MB/s', () => {
    expect(formatRate(1.5 * MB, 'es')).toBe(`1,5${nb}MB/s`)
    expect(formatRate(1.5 * MB, 'en')).toBe(`1.5${nb}MB/s`)
    expect(formatRate(42 * MB, 'en')).toBe(`42${nb}MB/s`)
  })
})

describe('formatDuration', () => {
  it('shows hours and minutes', () => {
    expect(formatDuration(2 * 3600 + 15 * 60, 'es')).toBe(`2${nb}h 15${nb}min`)
    expect(formatDuration(2 * 3600 + 15 * 60 + 59, 'en')).toBe(`2${nb}h 15${nb}min`)
  })

  it('omits the empty part', () => {
    expect(formatDuration(45 * 60, 'es')).toBe(`45${nb}min`)
    expect(formatDuration(3 * 3600, 'en')).toBe(`3${nb}h`)
  })

  it('says less than a minute for short or zero durations', () => {
    expect(formatDuration(30, 'es')).toBe(`<${nb}1${nb}min`)
    expect(formatDuration(0, 'en')).toBe(`<${nb}1${nb}min`)
  })

  it('groups large hour counts per language', () => {
    expect(formatDuration(1234 * 3600, 'en')).toBe(`1,234${nb}h`)
  })
})

describe('edge cases', () => {
  it('rolls a rounded value over to the next unit', () => {
    expect(formatBytes(1023.9 * 1024 ** 2, 'en')).toBe(`1${nb}GB`)
    expect(formatRate(1023.6 * 1024, 'es')).toBe(`1${nb}MB/s`)
    expect(formatRate(1023.4 * 1024, 'en')).toBe(`1,023${nb}KB/s`)
  })

  it('clamps percentages to 0–100', () => {
    expect(formatPercent(104, 'en')).toBe('100%')
    expect(formatPercent(-3, 'en')).toBe('0%')
  })

  it('shows a dash for NaN, infinite or negative quantities', () => {
    expect(formatPercent(Number.NaN, 'es')).toBe('—')
    expect(formatBytes(-1, 'es')).toBe('—')
    expect(formatBytes(Number.NaN, 'en')).toBe('—')
    expect(formatRate(-5, 'en')).toBe('—')
    expect(formatRate(Number.POSITIVE_INFINITY, 'en')).toBe('—')
    expect(formatDuration(-60, 'es')).toBe('—')
    expect(formatDuration(Number.NaN, 'en')).toBe('—')
  })
})
