import type { Language } from '../../../shared/settings/schema'

// Same mapping as `locale()` in use-t, which this Node-tested module cannot import (DOM types).
const locale = (language: Language): string => (language === 'es' ? 'es-ES' : 'en-US')

const DASH = '—'

/** Whole percent ("34 %" in Spanish, "34%" in English), clamped to 0–100; a dash when unknown. */
export function formatPercent(value: number | null, language: Language): string {
  if (value === null || !Number.isFinite(value)) return DASH
  const clamped = Math.min(100, Math.max(0, value))
  return new Intl.NumberFormat(locale(language), { style: 'percent', maximumFractionDigits: 0 }).format(clamped / 100)
}
