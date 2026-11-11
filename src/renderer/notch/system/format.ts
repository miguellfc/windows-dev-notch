import type { Language } from '../../../shared/settings/schema'

// Same mapping as `locale()` in use-t, which this Node-tested module cannot import (DOM types).
const locale = (language: Language): string => (language === 'es' ? 'es-ES' : 'en-US')

/** Intl puts a no-break space between a number and its unit; the units below follow it. */
const NB = ' '
const KB = 1024
const MB = 1024 ** 2
const GB = 1024 ** 3

const DASH = '—'
const BYTE_UNITS = [
  { size: MB, label: 'MB' },
  { size: GB, label: 'GB' },
] as const
const RATE_UNITS = [
  { size: KB, label: 'KB/s' },
  { size: MB, label: 'MB/s' },
] as const

/** A real, non-negative quantity; anything else (NaN, infinite, negative) shows as a dash. */
const isQuantity = (value: number): boolean => Number.isFinite(value) && value >= 0

/** One decimal below 10, whole numbers from 10; a trailing zero decimal is dropped. */
const round = (value: number): number => (value < 10 ? Math.round(value * 10) / 10 : Math.round(value))

/**
 * Picks the unit after rounding, so a value that rounds up to 1024 rolls over ("1023.9 MB" reads
 * "1 GB", never "1024 MB"). The last unit has no ceiling.
 */
function withUnit(value: number, units: readonly { size: number; label: string }[], language: Language): string {
  if (!isQuantity(value)) return DASH
  let index = 0
  while (index < units.length - 1 && round(value / units[index]!.size) >= 1024) index++
  const unit = units[index]!
  const amount = round(value / unit.size)
  return `${new Intl.NumberFormat(locale(language), { maximumFractionDigits: 1 }).format(amount)}${NB}${unit.label}`
}

/** Whole percent ("34 %" in Spanish, "34%" in English), clamped to 0–100; a dash when unknown. */
export function formatPercent(value: number | null, language: Language): string {
  if (value === null || !Number.isFinite(value)) return DASH
  const clamped = Math.min(100, Math.max(0, value))
  return new Intl.NumberFormat(locale(language), { style: 'percent', maximumFractionDigits: 0 }).format(clamped / 100)
}

/** Binary bytes as MB below 1 GB, GB from there. */
export function formatBytes(bytes: number, language: Language): string {
  return withUnit(bytes, BYTE_UNITS, language)
}

/** Transfer rate as KB/s below 1 MB/s, MB/s from there. */
export function formatRate(bytesPerSec: number, language: Language): string {
  return withUnit(bytesPerSec, RATE_UNITS, language)
}

/** "2 h 15 min", "45 min", "3 h"; anything under a minute reads "< 1 min". */
export function formatDuration(seconds: number, language: Language): string {
  if (!isQuantity(seconds)) return DASH
  const totalMinutes = Math.floor(seconds / 60)
  if (totalMinutes < 1) return `<${NB}1${NB}min`
  const number = new Intl.NumberFormat(locale(language))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${number.format(hours)}${NB}h`)
  if (minutes > 0) parts.push(`${number.format(minutes)}${NB}min`)
  return parts.join(' ')
}
