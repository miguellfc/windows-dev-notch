import { z } from 'zod'

/** The Redmine server URL is never longer than this. */
export const REDMINE_URL_MAX = 512

/**
 * Normalizes a Redmine server URL to origin + base path without a trailing `/`, or `null` when it is
 * not acceptable: only `https`, no credentials, no query or hash.
 */
export function normalizeRedmineUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > REDMINE_URL_MAX) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  // `new URL` drops an empty `?`/`#`; any of them in the input is refused all the same.
  if (url.search !== '' || url.hash !== '' || trimmed.includes('?') || trimmed.includes('#')) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** A Redmine server URL as typed by the user; parses to its normalized form. */
export const redmineUrlSchema = z
  .string()
  .max(REDMINE_URL_MAX)
  .transform((value, ctx) => {
    const normalized = normalizeRedmineUrl(value)
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'Only https URLs without credentials, query or hash' })
      return z.NEVER
    }
    return normalized
  })

/** True for `''` (not configured) or a URL already in its normalized form (what settings store). */
export const isStoredRedmineUrl = (value: string): boolean => value === '' || normalizeRedmineUrl(value) === value
