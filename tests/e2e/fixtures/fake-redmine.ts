import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for a Redmine server's REST API (E2E only), reached by the app through
 * NOTCH_REDMINE_BASE_URL (settings still hold the https URL the user typed). It plays Redmine
 * strictly: every request must carry the fake key in `X-Redmine-API-Key` (and nothing in
 * `Authorization`), and the queries must be exactly the ones the notch is meant to send; anything off
 * is recorded in `violations` (and refused). Writes change its state (status, estimate, time entries)
 * so the next reads show them. All data is fictional.
 */

export const FAKE_REDMINE_KEY = 'e2e-fake-redmine-key-5d1e8a40c7'
/** What the user types as the Redmine server (settings keep this https URL; the fake stands in for it). */
export const FAKE_REDMINE_ORIGIN = 'https://redmine.example.test'
export const FAKE_REDMINE_USER = { id: 77, login: 'usuaria.redmine', firstname: 'Usuaria', lastname: 'Ficticia' } as const
/** The account the notch shows: "firstname lastname". */
export const FAKE_REDMINE_ACCOUNT = `${FAKE_REDMINE_USER.firstname} ${FAKE_REDMINE_USER.lastname}`

export interface FakeStatus {
  id: number
  name: string
  closed: boolean
}

export const REDMINE_STATUSES: readonly FakeStatus[] = [
  { id: 1, name: 'Nueva', closed: false },
  { id: 2, name: 'En curso', closed: false },
  { id: 3, name: 'Resuelta', closed: false },
  { id: 5, name: 'Cerrada', closed: true },
]

export const REDMINE_ACTIVITIES = [
  { id: 8, name: 'Diseño', is_default: false },
  { id: 9, name: 'Desarrollo', is_default: true },
  { id: 10, name: 'Reuniones', is_default: false },
] as const

export interface FakeIssue {
  id: number
  subject: string
  project: string
  statusId: number
  estimatedHours: number | null
  spentHours: number
  /** Minutes before the fake started: the list is sorted by it (newest first). */
  minutesAgo: number
}

/** The user's open assigned issues, newest first. */
export const REDMINE_ISSUES: readonly FakeIssue[] = [
  { id: 4120, subject: 'Diseño de la pantalla de imputación', project: 'Portal Ejemplo', statusId: 1, estimatedHours: 6, spentHours: 1.5, minutesAgo: 8 },
  { id: 412, subject: 'Corregir el cálculo de las vacaciones', project: 'Nóminas Ficticias', statusId: 2, estimatedHours: null, spentHours: 3, minutesAgo: 50 },
  { id: 4012, subject: 'Revisar los permisos del informe mensual', project: 'Portal Ejemplo', statusId: 2, estimatedHours: 2, spentHours: 0, minutesAgo: 3 * 60 },
  { id: 3301, subject: 'Migrar la base de datos de pruebas', project: 'Infraestructura Demo', statusId: 1, estimatedHours: null, spentHours: 0, minutesAgo: 26 * 60 },
  { id: 2875, subject: 'Documentar la API de clientes', project: 'Nóminas Ficticias', statusId: 3, estimatedHours: 4, spentHours: 4.25, minutesAgo: 4 * 24 * 60 },
]

/** The statuses Redmine lets the user move each issue to (current one included). */
const ALLOWED_STATUS_IDS = [1, 2, 3]

/** A comment the specs type when logging time: like subjects, it must never reach a log file. */
export const REDMINE_LOG_COMMENT = 'Reunión de seguimiento con el equipo ficticio'

/** Every subject, project, name, comment and the key: none may reach a log file. */
export const SENSITIVE_DATA: readonly string[] = [
  ...REDMINE_ISSUES.flatMap((issue) => [issue.subject, issue.project]),
  FAKE_REDMINE_KEY,
  FAKE_REDMINE_ACCOUNT,
  FAKE_REDMINE_USER.login,
  FAKE_REDMINE_ORIGIN,
  'redmine.example.test',
  REDMINE_LOG_COMMENT,
]

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** `YYYY-MM-DD` of `d` in local time. */
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

export interface FakeTimeEntry {
  id: number
  issueId: number
  spentOn: string
  hours: number
  activityId: number
  comments: string
}

/** Today's hours already logged when the fake starts (on today's real local date). */
export const SEEDED_TODAY_HOURS = 2.5
/** Hours already logged on the 1st of the month (only when today is not the 1st). */
export const SEEDED_FIRST_HOURS = 3

/** The seeded entries for `now`: today's, the 1st of the month's, and one from 40 days ago (outside any range). */
function seedEntries(now: Date): FakeTimeEntry[] {
  const entries: FakeTimeEntry[] = [
    { id: 9001, issueId: 412, spentOn: localDay(now), hours: SEEDED_TODAY_HOURS, activityId: 9, comments: '' },
    { id: 9002, issueId: 4012, spentOn: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 40)), hours: 7, activityId: 9, comments: '' },
  ]
  if (now.getDate() !== 1) {
    entries.push({ id: 9003, issueId: 3301, spentOn: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), hours: SEEDED_FIRST_HOURS, activityId: 8, comments: '' })
  }
  return entries
}

/** What the summary must show for `now` (real clock) before anything is logged: today, the week (from Monday) and the month. */
export function expectedSeededSummary(now: Date): { today: number; week: number; month: number } {
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
  const firstHours = now.getDate() === 1 ? 0 : SEEDED_FIRST_HOURS
  return { today: SEEDED_TODAY_HOURS, week: SEEDED_TODAY_HOURS + (first >= monday ? firstHours : 0), month: SEEDED_TODAY_HOURS + firstHours }
}

export interface FakeRedmine {
  /** Origin of the fake: pass it as NOTCH_REDMINE_BASE_URL. */
  readonly base: string
  /** True: every request answers 401 (a revoked key or the REST API turned off). */
  unauthorized: boolean
  /** Issues whose writes (status, estimate, time entries) answer 403. */
  readonly forbiddenIssues: Set<number>
  /** Protocol mistakes seen so far (refused requests); a correct client leaves this empty. */
  readonly violations: string[]
  /** Requests per route ("viewer", "issues", "issue", "statuses", "activities", "update", "log", "time entries", "401", "403"). */
  readonly hits: Record<string, number>
  /** Every request (any route, 401s included). */
  readonly requests: { count: number }
  /** The issue as the fake holds it now. */
  issue(id: number): FakeIssue
  /** Every time entry the fake holds (seeded and logged). */
  readonly entries: readonly FakeTimeEntry[]
  close(): Promise<void>
}

const json = (res: ServerResponse, status: number, body?: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const PAGE_SIZE = 100

/** The exact query names of a request, sorted (so an extra or a missing parameter shows). */
const queryNames = (q: URLSearchParams): string => [...q.keys()].sort().join(',')

/** Hours as Redmine accepts them: 0 < h <= 24, at most 2 decimals. */
const validHours = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9

export async function startFakeRedmine(): Promise<FakeRedmine> {
  const startedAt = Date.now()
  const violations: string[] = []
  const hits: Record<string, number> = {}
  const requests = { count: 0 }
  const forbiddenIssues = new Set<number>()
  const issues: FakeIssue[] = REDMINE_ISSUES.map((issue) => ({ ...issue }))
  const entries: FakeTimeEntry[] = seedEntries(new Date(startedAt))
  let nextEntryId = 9100
  const state = { unauthorized: false }

  const hit = (key: string) => {
    hits[key] = (hits[key] ?? 0) + 1
  }
  const refuse = (res: ServerResponse, status: number, violation: string) => {
    violations.push(violation)
    json(res, status, { errors: ['refused by the fake server'] })
  }
  const status = (id: number): FakeStatus => REDMINE_STATUSES.find((s) => s.id === id)!
  const isoAgo = (minutes: number): string => new Date(startedAt - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const touch = (issue: FakeIssue) => {
    issue.minutesAgo = -(Date.now() - startedAt) / 60_000
  }

  const issueJson = (issue: FakeIssue, withAllowed: boolean) => ({
    id: issue.id,
    project: { id: 600 + issue.project.length, name: issue.project },
    tracker: { id: 1, name: 'Tarea' },
    status: { id: issue.statusId, name: status(issue.statusId).name, is_closed: status(issue.statusId).closed },
    priority: { id: 2, name: 'Normal' },
    author: { id: 12, name: 'Persona Ejemplo' },
    assigned_to: { id: FAKE_REDMINE_USER.id, name: FAKE_REDMINE_ACCOUNT },
    subject: issue.subject,
    description: '',
    start_date: null,
    due_date: null,
    done_ratio: 0,
    is_private: false,
    estimated_hours: issue.estimatedHours,
    total_estimated_hours: issue.estimatedHours,
    spent_hours: issue.spentHours,
    total_spent_hours: issue.spentHours,
    created_on: isoAgo(issue.minutesAgo + 600),
    updated_on: isoAgo(issue.minutesAgo),
    closed_on: null,
    ...(withAllowed ? { allowed_statuses: ALLOWED_STATUS_IDS.map((id) => ({ id, name: status(id).name, is_closed: status(id).closed })) } : {}),
  })

  /** `limit=100&offset=N` (N a multiple of 100); null after a violation was answered. */
  const page = (q: URLSearchParams, res: ServerResponse, route: string): number | null => {
    const offset = Number(q.get('offset'))
    if (q.get('limit') !== String(PAGE_SIZE) || !/^\d+$/.test(q.get('offset') ?? '') || offset % PAGE_SIZE !== 0) {
      refuse(res, 400, `${route}: not limit=100 with an offset in steps of 100`)
      return null
    }
    return offset
  }

  const handle = async (req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
    requests.count++
    if (req.headers.authorization !== undefined) return refuse(res, 400, 'Authorization header sent to Redmine')
    const key = req.headers['x-redmine-api-key']
    if (key !== FAKE_REDMINE_KEY || state.unauthorized) {
      // A wrong key is the user's mistake, not a protocol one: Redmine answers 401.
      if (key === undefined) violations.push('no X-Redmine-API-Key header')
      hit('401')
      return json(res, 401, {})
    }
    if (url.username || url.password) return refuse(res, 400, 'credentials in the URL')
    const path = url.pathname
    const q = url.searchParams
    const method = req.method ?? '?'

    if (method === 'GET' && path === '/users/current.json') {
      if (queryNames(q) !== '') return refuse(res, 400, 'users/current: unexpected query')
      hit('viewer')
      return json(res, 200, {
        user: { id: FAKE_REDMINE_USER.id, login: FAKE_REDMINE_USER.login, firstname: FAKE_REDMINE_USER.firstname, lastname: FAKE_REDMINE_USER.lastname, admin: false, created_on: isoAgo(90 * 24 * 60) },
      })
    }

    if (method === 'GET' && path === '/issues.json') {
      if (queryNames(q) !== 'assigned_to_id,limit,offset,sort,status_id') return refuse(res, 400, `issues: unexpected query ${queryNames(q)}`)
      if (q.get('assigned_to_id') !== 'me' || q.get('status_id') !== 'open' || q.get('sort') !== 'updated_on:desc') {
        return refuse(res, 400, 'issues: not assigned_to_id=me&status_id=open&sort=updated_on:desc')
      }
      const offset = page(q, res, 'issues')
      if (offset === null) return
      hit('issues')
      const open = issues.filter((issue) => !status(issue.statusId).closed).sort((a, b) => a.minutesAgo - b.minutesAgo)
      return json(res, 200, {
        issues: open.slice(offset, offset + PAGE_SIZE).map((issue) => issueJson(issue, false)),
        total_count: open.length,
        offset,
        limit: PAGE_SIZE,
      })
    }

    const one = /^\/issues\/(\d+)\.json$/.exec(path)
    if (one) {
      const issue = issues.find((i) => i.id === Number(one[1]))
      if (method === 'GET') {
        if (queryNames(q) !== 'include' || q.get('include') !== 'allowed_statuses') return refuse(res, 400, 'issue: not include=allowed_statuses')
        hit('issue')
        if (!issue) return json(res, 404, {})
        return json(res, 200, { issue: issueJson(issue, true) })
      }
      if (method === 'PUT') {
        if (queryNames(q) !== '') return refuse(res, 400, 'update: unexpected query')
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(res, 415, 'update: body is not JSON')
        let body: { issue?: Record<string, unknown> }
        try {
          body = JSON.parse(await readBody(req)) as typeof body
        } catch {
          return refuse(res, 400, 'update: unparsable body')
        }
        hit('update')
        const patch = body.issue ?? {}
        const keys = Object.keys(patch).sort().join(',')
        if (keys !== 'status_id' && keys !== 'estimated_hours') return refuse(res, 400, `update: unexpected fields ${keys}`)
        if (!issue) return json(res, 404, {})
        if (forbiddenIssues.has(issue.id)) {
          hit('403')
          return json(res, 403, {})
        }
        if ('status_id' in patch) {
          if (typeof patch['status_id'] !== 'number' || !ALLOWED_STATUS_IDS.includes(patch['status_id'])) {
            return json(res, 422, { errors: ['Estado no es válido'] })
          }
          issue.statusId = patch['status_id']
        } else {
          const value = patch['estimated_hours']
          if (value !== null && (typeof value !== 'number' || value < 0 || value > 999)) return json(res, 422, { errors: ['Tiempo estimado no es válido'] })
          issue.estimatedHours = value as number | null
        }
        touch(issue)
        return json(res, 204)
      }
      return refuse(res, 405, `issue: ${method}`)
    }

    if (method === 'GET' && path === '/issue_statuses.json') {
      hit('statuses')
      return json(res, 200, { issue_statuses: REDMINE_STATUSES.map((s) => ({ id: s.id, name: s.name, is_closed: s.closed })) })
    }

    if (method === 'GET' && path === '/enumerations/time_entry_activities.json') {
      if (queryNames(q) !== '') return refuse(res, 400, 'activities: unexpected query')
      hit('activities')
      return json(res, 200, { time_entry_activities: REDMINE_ACTIVITIES.map((a) => ({ ...a, active: true })) })
    }

    if (path === '/time_entries.json' && method === 'GET') {
      if (queryNames(q) !== 'from,limit,offset,to,user_id') return refuse(res, 400, `time entries: unexpected query ${queryNames(q)}`)
      const from = q.get('from') ?? ''
      const to = q.get('to') ?? ''
      if (q.get('user_id') !== 'me' || !DAY.test(from) || !DAY.test(to) || from > to) {
        return refuse(res, 400, 'time entries: not user_id=me with an ordered from/to pair of dates')
      }
      const offset = page(q, res, 'time entries')
      if (offset === null) return
      hit('time entries')
      const inRange = entries.filter((e) => e.spentOn >= from && e.spentOn <= to)
      return json(res, 200, {
        time_entries: inRange.slice(offset, offset + PAGE_SIZE).map((e) => ({
          id: e.id,
          project: { id: 600, name: issues.find((i) => i.id === e.issueId)?.project ?? 'Proyecto' },
          issue: { id: e.issueId },
          user: { id: FAKE_REDMINE_USER.id, name: FAKE_REDMINE_ACCOUNT },
          activity: { id: e.activityId, name: REDMINE_ACTIVITIES.find((a) => a.id === e.activityId)?.name ?? '' },
          hours: e.hours,
          comments: e.comments,
          spent_on: e.spentOn,
          created_on: isoAgo(0),
          updated_on: isoAgo(0),
        })),
        total_count: inRange.length,
        offset,
        limit: PAGE_SIZE,
      })
    }

    if (path === '/time_entries.json' && method === 'POST') {
      if (queryNames(q) !== '') return refuse(res, 400, 'log: unexpected query')
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(res, 415, 'log: body is not JSON')
      let body: { time_entry?: Record<string, unknown> }
      try {
        body = JSON.parse(await readBody(req)) as typeof body
      } catch {
        return refuse(res, 400, 'log: unparsable body')
      }
      hit('log')
      const entry = body.time_entry ?? {}
      if (Object.keys(entry).sort().join(',') !== 'activity_id,comments,hours,issue_id,spent_on') return refuse(res, 400, 'log: unexpected fields')
      const issue = issues.find((i) => i.id === entry['issue_id'])
      if (!issue) return json(res, 422, { errors: ['Petición no es válido'] })
      if (forbiddenIssues.has(issue.id)) {
        hit('403')
        return json(res, 403, {})
      }
      const spentOn = entry['spent_on']
      const hours = entry['hours']
      const activityId = entry['activity_id']
      const comments = entry['comments']
      if (typeof spentOn !== 'string' || !DAY.test(spentOn) || spentOn > localDay(new Date())) return refuse(res, 400, 'log: spent_on is not a past or present local date')
      if (!validHours(hours)) return refuse(res, 400, 'log: hours out of range')
      if (!REDMINE_ACTIVITIES.some((a) => a.id === activityId)) return refuse(res, 400, 'log: unknown activity')
      if (typeof comments !== 'string' || comments.length > 255) return refuse(res, 400, 'log: comments not a string of at most 255')
      const saved: FakeTimeEntry = { id: nextEntryId++, issueId: issue.id, spentOn, hours, activityId: activityId as number, comments }
      entries.push(saved)
      issue.spentHours = Math.round((issue.spentHours + hours) * 100) / 100
      touch(issue)
      return json(res, 201, { time_entry: { id: saved.id, issue: { id: issue.id }, hours, spent_on: spentOn, comments } })
    }

    return refuse(res, 404, `unknown route ${method} ${path}`)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    handle(req, url, res).catch(() => {
      if (!res.headersSent) json(res, 500, { errors: ['fake server failure'] })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    base: `http://127.0.0.1:${port}`,
    get unauthorized() {
      return state.unauthorized
    },
    set unauthorized(value: boolean) {
      state.unauthorized = value
    },
    forbiddenIssues,
    violations,
    hits,
    requests,
    issue(id) {
      const found = issues.find((i) => i.id === id)
      if (!found) throw new Error(`no issue #${id}`)
      return found
    },
    entries,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
