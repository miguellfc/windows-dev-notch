import { z } from 'zod'

/** Each list (`toReview`, `mine`) holds at most this many items. */
export const CODE_REVIEW_LIST_LIMIT = 20
/** Unreviewed counts are capped here; the UI shows 100 as "99+". */
export const CODE_REVIEW_COUNT_CAP = 100
/** Titles, refs and authors are cut to this many characters before they leave the client. */
export const CODE_REVIEW_TEXT_MAX = 1000
/** Item ids (GitHub node ids, `projectId!iid` on GitLab) are short; the bound keeps requests small. */
export const CODE_REVIEW_ID_MAX = 256
/** A personal access token is never longer than this. */
export const CODE_REVIEW_TOKEN_MAX = 255
/** The GitLab server URL is never longer than this. */
export const GITLAB_URL_MAX = 512

export const platformSchema = z.enum(['github', 'gitlab'])
export type Platform = z.infer<typeof platformSchema>

export const reviewStateSchema = z.enum(['none', 'approved', 'changes', 'commented'])
export type ReviewState = z.infer<typeof reviewStateSchema>

/** A review that counts as "reviewed" (what an alert announces). */
export const reviewKindSchema = z.enum(['approved', 'changes', 'commented'])
export type ReviewKind = z.infer<typeof reviewKindSchema>

export const checksSchema = z.enum(['pass', 'fail', 'running']).nullable()
export type Checks = z.infer<typeof checksSchema>

const idSchema = z.string().min(1).max(CODE_REVIEW_ID_MAX)
const textSchema = z.string().max(CODE_REVIEW_TEXT_MAX)

/** One PR/MR as the notch sees it (no URL: main opens it by id). */
export const itemSchema = z.strictObject({
  id: idSchema,
  /** `owner/repo#123` (GitHub) or `group/project!45` (GitLab). */
  ref: textSchema,
  title: textSchema,
  author: textSchema,
  /** ISO time of the last update. */
  updatedAt: z.string().max(64),
  draft: z.boolean(),
  review: reviewStateSchema,
  checks: checksSchema,
  conflicts: z.boolean(),
})
export type ReviewItem = z.infer<typeof itemSchema>

/** `code-review:list` output. */
export const codeReviewListSchema = z.strictObject({
  toReview: z.array(itemSchema).max(CODE_REVIEW_LIST_LIMIT),
  mine: z.array(itemSchema).max(CODE_REVIEW_LIST_LIMIT),
})
export type CodeReviewList = z.infer<typeof codeReviewListSchema>

export const platformStatusSchema = z.enum(['unconfigured', 'ok', 'offline', 'auth-error'])
export type PlatformStatus = z.infer<typeof platformStatusSchema>

export const platformStateSchema = z.strictObject({
  status: platformStatusSchema,
  /** Login (GitHub) or username (GitLab) of the token's account. */
  account: z.string().max(CODE_REVIEW_TEXT_MAX).nullable(),
  /** Own open, non-draft PR/MRs without any review. */
  unreviewed: z.int().min(0).max(CODE_REVIEW_COUNT_CAP).nullable(),
  /** ISO time of the last successful query. */
  updatedAt: z.string().nullable(),
  /** False when the token lives only in memory (no OS encryption) and will not survive a restart. */
  persistent: z.boolean(),
})
export type PlatformState = z.infer<typeof platformStateSchema>

export const codeReviewStateSchema = z.strictObject({ github: platformStateSchema, gitlab: platformStateSchema })
export type CodeReviewState = z.infer<typeof codeReviewStateSchema>

/** Event main -> notch when own PR/MRs get their first review; `kind`/`ref`/`title` only for a single one. */
export const codeReviewAlertSchema = z.strictObject({
  platform: platformSchema,
  count: z.int().min(1),
  kind: reviewKindSchema.optional(),
  ref: textSchema.optional(),
  title: textSchema.optional(),
})
export type CodeReviewAlert = z.infer<typeof codeReviewAlertSchema>

/**
 * Normalizes a GitLab server URL to origin + base path without a trailing `/`, or `null` when it is
 * not acceptable: only `https`, no credentials, no query or hash.
 */
export function normalizeGitlabUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > GITLAB_URL_MAX) return null
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

/** A GitLab server URL as typed by the user; parses to its normalized form. */
export const gitlabUrlSchema = z
  .string()
  .max(GITLAB_URL_MAX)
  .transform((value, ctx) => {
    const normalized = normalizeGitlabUrl(value)
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'Only https URLs without credentials, query or hash' })
      return z.NEVER
    }
    return normalized
  })

/** True for `''` (not configured) or a URL already in its normalized form (what settings store). */
export const isStoredGitlabUrl = (value: string): boolean => value === '' || normalizeGitlabUrl(value) === value

// IPC inputs.
export const listInputSchema = z.strictObject({ platform: platformSchema })
export type ListInput = z.infer<typeof listInputSchema>

export const openInputSchema = z.strictObject({ platform: platformSchema, id: idSchema })
export type OpenInput = z.infer<typeof openInputSchema>

export const setTokenInputSchema = z.strictObject({
  platform: platformSchema,
  token: z.string().min(1).max(CODE_REVIEW_TOKEN_MAX),
  /** GitLab server URL as typed (validated and normalized in main). */
  url: z.string().max(GITLAB_URL_MAX).optional(),
})
export type SetTokenInput = z.infer<typeof setTokenInputSchema>

export const setTokenResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), account: z.string().max(CODE_REVIEW_TEXT_MAX) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['auth', 'network', 'url']) }),
])
export type SetTokenResult = z.infer<typeof setTokenResultSchema>

export const clearInputSchema = z.strictObject({ platform: platformSchema })
export type ClearInput = z.infer<typeof clearInputSchema>

// Contributions (milestone 2).
const dayKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)

/** One square of the month chart. Days outside the month have `inMonth: false` and count 0. */
export const contributionDaySchema = z.strictObject({
  /** Local date `YYYY-MM-DD`. */
  date: dayKeySchema,
  count: z.int().min(0),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  inMonth: z.boolean(),
  /** After today (local). */
  future: z.boolean(),
})
export type ContributionDay = z.infer<typeof contributionDaySchema>
export type ContributionLevel = ContributionDay['level']

export const contributionTotalsSchema = z.strictObject({
  commits: z.int().min(0),
  opened: z.int().min(0),
  merged: z.int().min(0),
  reviews: z.int().min(0),
})
export type ContributionTotals = z.infer<typeof contributionTotalsSchema>

/** `code-review:contributions` output: the current month's chart plus today / week / month totals. */
export const contributionSummarySchema = z.strictObject({
  /** `YYYY-MM` (local). */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  /** Columns Monday -> Sunday; 4 (a 28-day month starting on Monday) to 6. */
  weeks: z.array(z.array(contributionDaySchema).length(7)).min(4).max(6),
  /** Contributions in the month (sum of the chart). */
  monthTotal: z.int().min(0),
  activeDays: z.int().min(0).max(31),
  today: contributionTotalsSchema,
  week: contributionTotalsSchema,
  monthTotals: contributionTotalsSchema,
  /** GitLab: the page limit was reached, older events of the month are missing. */
  partial: z.boolean(),
  /** GitHub: there are private contributions that are not detailed. */
  restricted: z.boolean(),
  /** ISO time of the query. */
  updatedAt: z.string().max(64),
})
export type ContributionSummary = z.infer<typeof contributionSummarySchema>

export const contributionsInputSchema = z.strictObject({ platform: platformSchema })
export type ContributionsInput = z.infer<typeof contributionsInputSchema>

/**
 * `code-review:contributions` output: the cached summary (null when not connected or not loaded yet)
 * and whether the last query failed (the summary, if any, is the last good one).
 */
export const contributionsResultSchema = z.strictObject({ summary: contributionSummarySchema.nullable(), error: z.boolean() })
export type ContributionsResult = z.infer<typeof contributionsResultSchema>

/** `code-review:view` input: the notch's "Revisiones" view opened or closed (contributions poll only while open). */
export const codeReviewViewInputSchema = z.strictObject({ open: z.boolean() })
export type CodeReviewViewInput = z.infer<typeof codeReviewViewInputSchema>

/**
 * Event main -> notch: a platform's contributions changed (new summary, cache cleared) or a query
 * ended; `error` is true while the last query failed (the cached summary, if any, is kept).
 * Never repositories or titles: the notch reads the summary with `code-review:contributions`.
 */
export const contributionsChangedSchema = z.strictObject({ platform: platformSchema, error: z.boolean() })
export type ContributionsChanged = z.infer<typeof contributionsChangedSchema>
