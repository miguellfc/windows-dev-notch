import { z } from 'zod'
import type {
  LogTimeInput,
  RedmineActivity,
  RedmineIssue,
  RedmineIssueDetail,
  RedmineIssueList,
  RedmineWriteError,
  RedmineWriteResult,
} from '../../shared/redmine/schema'
import { normalizeRedmineUrl } from '../../shared/redmine/url'
import { CodeReviewError, clip, readJson, send, sendRaw, type CodeReviewFetch } from '../code-review/client-common'

// Redmine responses: not strict, and optional fields wherever Redmine (or a plugin/version) may omit them.
const namedSchema = z.object({ id: z.int(), name: z.string() })
const hoursSchema = z.number().min(0).nullable().optional()

const userSchema = z.object({
  user: z.object({
    id: z.int().positive(),
    login: z.string(),
    firstname: z.string().nullable().optional(),
    lastname: z.string().nullable().optional(),
  }),
})

const issueSchema = z.object({
  id: z.int().min(1),
  subject: z.string(),
  project: z.object({ name: z.string() }),
  status: namedSchema,
  estimated_hours: hoursSchema,
  spent_hours: hoursSchema,
  total_spent_hours: hoursSchema,
  updated_on: z.string(),
  allowed_statuses: z.array(namedSchema).nullable().optional(),
})
type RawIssue = z.infer<typeof issueSchema>

const totalCount = z.int().min(0).nullable().optional()
const issueListSchema = z.object({ issues: z.array(issueSchema), total_count: totalCount })
const issueDetailSchema = z.object({ issue: issueSchema })
const statusListSchema = z.object({ issue_statuses: z.array(namedSchema) })
const activityListSchema = z.object({
  time_entry_activities: z.array(namedSchema.extend({ is_default: z.boolean().nullable().optional() })),
})
/** A local day `YYYY-MM-DD` (the summary and today's hours are keyed by it). */
const dayKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
const timeEntryListSchema = z.object({
  time_entries: z.array(z.object({ spent_on: dayKeySchema, hours: z.number().min(0) })),
  total_count: totalCount,
})
/** Body of a 422: `{ errors: ['Status is invalid', ...] }`. */
const validationSchema = z.object({ errors: z.array(z.string()) })

/** Items per page and the most pages read per query. */
export const REDMINE_PAGE_SIZE = 100
export const REDMINE_ISSUE_MAX_PAGES = 3
export const REDMINE_TIME_ENTRY_MAX_PAGES = 10

const VALIDATION_MESSAGE_MAX = 200
const VALIDATION_MESSAGES_MAX = 3

const isLoopbackHttp = (baseUrl: string): boolean => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)

export interface RedmineClientOptions {
  fetch: CodeReviewFetch
  /** Normalized server URL (origin + base path, no trailing `/`; https only). */
  baseUrl: string
  /** Sent as `X-Redmine-API-Key`; never logged. */
  apiKey: string
  /** Dev/E2E only: also accept `http://127.0.0.1:<port>` (a fake local server). */
  allowLoopbackHttp?: boolean
}

export interface RedmineStatusRef {
  id: number
  name: string
}

export interface RedmineClient {
  /** The key's account: id and display name ("firstname lastname", or the login). */
  viewer(): Promise<{ id: number; name: string }>
  /** Open issues assigned to the user (at most 300, most recently updated first, each id once). */
  issues(): Promise<RedmineIssueList>
  issue(id: number): Promise<RedmineIssueDetail>
  /** All issue statuses (cached for the session of this client). */
  statuses(): Promise<RedmineStatusRef[]>
  /** Time entry activities (cached for the session of this client). */
  activities(): Promise<RedmineActivity[]>
  updateIssue(id: number, patch: { statusId?: number; estimatedHours?: number | null }): Promise<RedmineWriteResult>
  logTime(entry: LogTimeInput): Promise<RedmineWriteResult>
  /** The user's time entries between two local dates (inclusive), one item per entry (at most 1000). */
  timeEntries(from: string, to: string): Promise<{ date: string; hours: number }[]>
  /** URL of the issue in Redmine (opened by main in the browser, never sent to the renderer). */
  issueUrl(id: number): string
}

const toIssue = (raw: RawIssue): RedmineIssue => ({
  id: raw.id,
  subject: clip(raw.subject, 512),
  project: clip(raw.project.name, 512),
  status: { id: raw.status.id, name: clip(raw.status.name, 512) },
  estimatedHours: raw.estimated_hours ?? null,
  spentHours: raw.spent_hours ?? raw.total_spent_hours ?? null,
  updatedOn: clip(raw.updated_on, 512),
})

const displayName = ({ user }: z.infer<typeof userSchema>): string => {
  const full = `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim()
  return full === '' ? user.login : full
}

/** Write failure by status: 401 auth, 403 forbidden, 404 not-found, 422 validation, 5xx/429 server, the rest invalid-response. */
const writeReason = (status: number): RedmineWriteError => {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 422) return 'validation'
  if (status === 429 || status >= 500) return 'server'
  return 'invalid-response'
}

async function validationMessages(response: Response): Promise<string[] | undefined> {
  try {
    const parsed = validationSchema.safeParse(await response.json())
    if (!parsed.success) return undefined
    const messages = parsed.data.errors.slice(0, VALIDATION_MESSAGES_MAX).map((message) => clip(message, VALIDATION_MESSAGE_MAX))
    return messages.length > 0 ? messages : undefined
  } catch {
    return undefined
  }
}

/**
 * Redmine REST client: every request carries `X-Redmine-API-Key`, never follows a redirect and times
 * out (client-common). Reads throw `CodeReviewError`; writes never throw and return a `RedmineWriteResult`.
 */
export function createRedmineClient({ fetch: doFetch, baseUrl, apiKey, allowLoopbackHttp = false }: RedmineClientOptions): RedmineClient {
  if (normalizeRedmineUrl(baseUrl) !== baseUrl && !(allowLoopbackHttp && isLoopbackHttp(baseUrl))) {
    throw new Error('Redmine base URL must be a normalized https URL')
  }
  const headers = { 'x-redmine-api-key': apiKey, accept: 'application/json' }

  const url = (path: string, query: Record<string, string> = {}): string => {
    const target = new URL(`${baseUrl}/${path}`)
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value)
    return target.toString()
  }

  const get = async <S extends z.ZodType>(path: string, schema: S, query?: Record<string, string>): Promise<z.output<S>> => {
    const response = await send(doFetch, url(path, query), { headers })
    if (response === null) throw new CodeReviewError('invalid-response') // unreachable without allowNotFound
    return readJson(response, schema)
  }

  /**
   * Reads `path` page by page (`limit`/`offset`) until a short or empty page, `maxPages`, or the
   * reported total is reached. `total_count` only shortens the loop; a wrong one can never extend it.
   */
  const paged = async <S extends z.ZodType, T>(
    path: string,
    query: Record<string, string>,
    maxPages: number,
    schema: S,
    read: (body: z.output<S>) => { items: T[]; total: number | null | undefined },
  ): Promise<{ items: T[]; more: boolean }> => {
    const items: T[] = []
    let total: number | null | undefined
    for (let index = 0; index < maxPages; index++) {
      const offset = index * REDMINE_PAGE_SIZE
      const result = read(await get(path, schema, { ...query, limit: String(REDMINE_PAGE_SIZE), offset: String(offset) }))
      total = result.total
      items.push(...result.items)
      const full = result.items.length >= REDMINE_PAGE_SIZE
      if (!full || (total != null && offset + result.items.length >= total)) return { items, more: false }
    }
    return { items, more: total == null || total > items.length }
  }

  let statusCache: Promise<RedmineStatusRef[]> | null = null
  let activityCache: Promise<RedmineActivity[]> | null = null

  /** Caches a successful read for the lifetime of the client; a failure is not cached. */
  const cached = <T>(slot: Promise<T> | null, load: () => Promise<T>, store: (value: Promise<T> | null) => void): Promise<T> => {
    if (slot !== null) return slot
    const value = load()
    store(value)
    value.catch(() => store(null))
    return value
  }

  const statuses = (): Promise<RedmineStatusRef[]> =>
    cached(
      statusCache,
      async () => (await get('issue_statuses.json', statusListSchema)).issue_statuses.map(({ id, name }) => ({ id, name: clip(name, 512) })),
      (value) => (statusCache = value),
    )

  const activities = (): Promise<RedmineActivity[]> =>
    cached(
      activityCache,
      async () =>
        (await get('enumerations/time_entry_activities.json', activityListSchema)).time_entry_activities.map((a) => ({
          id: a.id,
          name: clip(a.name, 512),
          isDefault: a.is_default ?? false,
        })),
      (value) => (activityCache = value),
    )

  /** One write: any status maps to a result; only transport failures are mapped from `CodeReviewError`. */
  const write = async (method: 'PUT' | 'POST', path: string, body: unknown): Promise<RedmineWriteResult> => {
    let response: Response
    try {
      response = await sendRaw(doFetch, url(path), {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      if (error instanceof CodeReviewError && error.code === 'network') return { ok: false, reason: 'network' }
      return { ok: false, reason: 'invalid-response' }
    }
    if (response.ok) return { ok: true }
    const reason = writeReason(response.status)
    if (reason !== 'validation') return { ok: false, reason }
    const messages = await validationMessages(response)
    return messages === undefined ? { ok: false, reason } : { ok: false, reason, messages }
  }

  return {
    viewer: async () => {
      const parsed = await get('users/current.json', userSchema)
      return { id: parsed.user.id, name: clip(displayName(parsed), 512) }
    },

    issues: async () => {
      const { items, more } = await paged(
        'issues.json',
        { assigned_to_id: 'me', status_id: 'open', sort: 'updated_on:desc' },
        REDMINE_ISSUE_MAX_PAGES,
        issueListSchema,
        (body) => ({ items: body.issues.map(toIssue), total: body.total_count }),
      )
      // An issue updated while paging moves to the top and may show up again on a later page: keep its first sighting.
      const seen = new Set<number>()
      const issues = items.filter((issue) => {
        if (seen.has(issue.id)) return false
        seen.add(issue.id)
        return true
      })
      return { issues, truncated: more }
    },

    issue: async (id) => {
      const { issue } = await get(`issues/${id}.json`, issueDetailSchema, { include: 'allowed_statuses' })
      const allowed = issue.allowed_statuses ?? (await statuses())
      return { ...toIssue(issue), allowedStatuses: allowed.map(({ id: statusId, name }) => ({ id: statusId, name: clip(name, 512) })) }
    },

    statuses,
    activities,

    updateIssue: (id, patch) => {
      const issue: Record<string, unknown> = {}
      if (patch.statusId !== undefined) issue['status_id'] = patch.statusId
      if (patch.estimatedHours !== undefined) issue['estimated_hours'] = patch.estimatedHours
      return write('PUT', `issues/${id}.json`, { issue })
    },

    logTime: (entry) =>
      write('POST', 'time_entries.json', {
        time_entry: {
          issue_id: entry.issueId,
          spent_on: entry.spentOn,
          hours: entry.hours,
          activity_id: entry.activityId,
          comments: entry.comments,
        },
      }),

    timeEntries: async (from, to) => {
      const { items } = await paged(
        'time_entries.json',
        { user_id: 'me', from, to },
        REDMINE_TIME_ENTRY_MAX_PAGES,
        timeEntryListSchema,
        (body) => ({ items: body.time_entries.map((e) => ({ date: e.spent_on, hours: e.hours })), total: body.total_count }),
      )
      return items
    },

    issueUrl: (id) => `${baseUrl}/issues/${id}`,
  }
}
