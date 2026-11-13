import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for GitHub's GraphQL API and a GitLab server's REST API (E2E only), reached by the
 * app through NOTCH_CODE_REVIEW_BASE_URLS (`github=<base>,gitlab=<base>`: both on this one server).
 * GitHub lives at `POST /graphql` (bearer token), GitLab at `GET /api/v4/…` (`PRIVATE-TOKEN`). It plays
 * both strictly: each request must carry its own platform's fake token in its own header, and the
 * queries must be the ones the notch is meant to send; anything off is recorded in `violations` (and
 * refused). Item URLs point at https://github.com and the https GitLab origin the settings hold, as
 * the real servers would. All data is fictional (example names, `example.test` hosts).
 */

export const FAKE_GITHUB_TOKEN = 'e2e-fake-github-token-7f3a91c2'
export const FAKE_GITLAB_TOKEN = 'e2e-fake-gitlab-token-91c27f3a'
export const FAKE_GITHUB_LOGIN = 'usuaria-prueba'
export const FAKE_GITLAB_USER = { id: 4242, username: 'usuaria.prueba' } as const
/** What the user types as the GitLab server (settings keep this https origin; the fake stands in for it). */
export const FAKE_GITLAB_ORIGIN = 'https://gitlab.example.test'

export type FakeReview = 'approved' | 'changes' | 'commented'
type Checks = 'SUCCESS' | 'FAILURE' | 'PENDING' | null

export interface FakePr {
  id: string
  number: number
  repo: string
  title: string
  author: string
  draft: boolean
  checks: Checks
  conflicts: boolean
  minutesAgo: number
  /** Reviews by others, oldest first. */
  reviews: { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; author: string }[]
}

export interface FakeMr {
  projectId: number
  iid: number
  path: string
  title: string
  author: string
  draft: boolean
  pipeline: 'success' | 'failed' | 'running' | null
  conflicts: boolean
  minutesAgo: number
  /** Users who approved (never the author). */
  approvedBy: string[]
  /** Reviewers with their state (GitLab 15.9+ `/reviewers`). */
  reviewers: { username: string; state: 'unreviewed' | 'reviewed' | 'requested_changes' | 'approved' }[]
}

const HOUR = 60

/** Review requested from the user on GitHub: three. */
export const GITHUB_TO_REVIEW: readonly FakePr[] = [
  {
    id: 'PR_kwE2E001',
    number: 412,
    repo: 'acme-ejemplo/web-app',
    title: 'Ajustar el tiempo de espera del inicio de sesión',
    author: 'rosa-ejemplo',
    draft: false,
    checks: 'SUCCESS',
    conflicts: false,
    minutesAgo: 12,
    reviews: [],
  },
  {
    id: 'PR_kwE2E002',
    number: 88,
    repo: 'acme-ejemplo/api-pagos',
    title: 'Validar importes negativos en los reembolsos',
    author: 'pablo-ficticio',
    draft: false,
    checks: 'FAILURE',
    conflicts: true,
    minutesAgo: 3 * HOUR,
    reviews: [],
  },
  {
    id: 'PR_kwE2E003',
    number: 17,
    repo: 'otra-org-ejemplo/manual',
    title: 'Corregir enlaces rotos de la guía de estilo',
    author: 'irene-prueba',
    draft: false,
    checks: 'PENDING',
    conflicts: false,
    minutesAgo: 26 * HOUR,
    reviews: [],
  },
]

/** The user's own open PRs: four; two unreviewed, one approved, one draft (never counted). */
export const GITHUB_MINE: readonly FakePr[] = [
  {
    id: 'PR_kwE2E101',
    number: 420,
    repo: 'acme-ejemplo/web-app',
    title: 'Mover el selector de idioma a los ajustes',
    author: FAKE_GITHUB_LOGIN,
    draft: false,
    checks: 'SUCCESS',
    conflicts: false,
    minutesAgo: 25,
    reviews: [],
  },
  {
    id: 'PR_kwE2E102',
    number: 57,
    repo: 'acme-ejemplo/notch-core',
    title: 'Medir el ancho de la cápsula con dos bloques',
    author: FAKE_GITHUB_LOGIN,
    draft: false,
    checks: 'PENDING',
    conflicts: false,
    minutesAgo: 2 * HOUR,
    reviews: [],
  },
  {
    id: 'PR_kwE2E103',
    number: 401,
    repo: 'acme-ejemplo/web-app',
    title: 'Quitar dependencias que ya no se usan',
    author: FAKE_GITHUB_LOGIN,
    draft: false,
    checks: 'SUCCESS',
    conflicts: false,
    minutesAgo: 30 * HOUR,
    reviews: [{ state: 'APPROVED', author: 'rosa-ejemplo' }],
  },
  {
    id: 'PR_kwE2E104',
    number: 425,
    repo: 'acme-ejemplo/web-app',
    title: 'Nueva vista de actividad mensual',
    author: FAKE_GITHUB_LOGIN,
    draft: true,
    checks: null,
    conflicts: false,
    minutesAgo: 4 * 24 * HOUR,
    reviews: [],
  },
]

/** Review requested from the user on GitLab: two. */
export const GITLAB_TO_REVIEW: readonly FakeMr[] = [
  {
    projectId: 310,
    iid: 31,
    path: 'grupo-ejemplo/plataforma/backend',
    title: 'Cachear la consulta de permisos por proyecto',
    author: 'luis.prueba',
    draft: false,
    pipeline: 'success',
    conflicts: false,
    minutesAgo: 40,
    approvedBy: [],
    reviewers: [],
  },
  {
    projectId: 320,
    iid: 9,
    path: 'grupo-ejemplo/movil',
    title: 'Actualizar los iconos de la barra inferior',
    author: 'ana.ejemplo',
    draft: false,
    pipeline: 'running',
    conflicts: true,
    minutesAgo: 5 * HOUR,
    approvedBy: [],
    reviewers: [],
  },
]

/** The user's own open MRs: three; one unreviewed, one approved, one draft. */
export const GITLAB_MINE: readonly FakeMr[] = [
  {
    projectId: 330,
    iid: 64,
    path: 'grupo-ejemplo/plataforma/frontend',
    title: 'Paginar la tabla de despliegues',
    author: FAKE_GITLAB_USER.username,
    draft: false,
    pipeline: 'success',
    conflicts: false,
    minutesAgo: 15,
    approvedBy: [],
    reviewers: [{ username: 'luis.prueba', state: 'unreviewed' }],
  },
  {
    projectId: 330,
    iid: 60,
    path: 'grupo-ejemplo/plataforma/frontend',
    title: 'Traducir los mensajes de error del formulario',
    author: FAKE_GITLAB_USER.username,
    draft: false,
    pipeline: 'failed',
    conflicts: false,
    minutesAgo: 20 * HOUR,
    approvedBy: ['ana.ejemplo'],
    reviewers: [{ username: 'ana.ejemplo', state: 'approved' }],
  },
  {
    projectId: 340,
    iid: 12,
    path: 'grupo-ejemplo/infra',
    title: 'Migrar los runners a la nueva red',
    author: FAKE_GITLAB_USER.username,
    draft: true,
    pipeline: null,
    conflicts: false,
    minutesAgo: 3 * 24 * HOUR,
    approvedBy: [],
    reviewers: [],
  },
]

export const githubPrUrl = (pr: Pick<FakePr, 'repo' | 'number'>): string => `https://github.com/${pr.repo}/pull/${pr.number}`
export const gitlabMrUrl = (mr: Pick<FakeMr, 'path' | 'iid'>): string => `${FAKE_GITLAB_ORIGIN}/${mr.path}/-/merge_requests/${mr.iid}`
export const githubRef = (pr: Pick<FakePr, 'repo' | 'number'>): string => `${pr.repo}#${pr.number}`
export const gitlabRef = (mr: Pick<FakeMr, 'path' | 'iid'>): string => `${mr.path}!${mr.iid}`

/** Every title, repository and person in the fake data: none may reach a log file. */
export const SENSITIVE_DATA: readonly string[] = [
  ...[...GITHUB_TO_REVIEW, ...GITHUB_MINE].flatMap((pr) => [pr.title, pr.repo, pr.author, ...pr.reviews.map((r) => r.author)]),
  ...[...GITLAB_TO_REVIEW, ...GITLAB_MINE].flatMap((mr) => [mr.title, mr.path, mr.author, ...mr.approvedBy, ...mr.reviewers.map((r) => r.username)]),
  FAKE_GITHUB_LOGIN,
  FAKE_GITLAB_USER.username,
  FAKE_GITHUB_TOKEN,
  FAKE_GITLAB_TOKEN,
]

/** The search strings the notch must send (see github-client.ts). */
const GITHUB_SEARCHES = {
  toReview: 'is:open is:pr review-requested:@me archived:false',
  mine: 'is:open is:pr author:@me archived:false',
  unreviewed: 'is:open is:pr author:@me archived:false draft:false review:none',
}

export type FakePlatform = 'github' | 'gitlab'

export interface FakeCodeReview {
  /** Origin of the fake: pass `github=<base>,gitlab=<base>` as NOTCH_CODE_REVIEW_BASE_URLS. */
  readonly base: string
  /** Per platform, true: every request answers 401 (an expired or revoked token). */
  readonly unauthorized: Record<FakePlatform, boolean>
  /** Protocol mistakes seen so far (refused requests); a correct client leaves this empty. */
  readonly violations: string[]
  /** Requests per route ("github viewer", "github fetch", "gitlab user", "gitlab mine", "gitlab approvals", …). */
  readonly hits: Record<string, number>
  /** Requests per platform (any route, 401s included). */
  readonly requests: Record<FakePlatform, number>
  /** Someone else reviews one of the user's GitHub PRs (by id). */
  reviewPr(id: string, review: FakeReview, by?: string): void
  /** Someone else reviews one of the user's GitLab MRs (by iid). */
  reviewMr(iid: number, review: FakeReview, by?: string): void
  close(): Promise<void>
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/** GitLab's numeric user ids for the fictional people (the user is FAKE_GITLAB_USER.id). */
const gitlabUserId = (username: string): number =>
  username === FAKE_GITLAB_USER.username ? FAKE_GITLAB_USER.id : 5000 + [...username].reduce((sum, c) => sum + c.charCodeAt(0), 0)

export async function startFakeCodeReview(): Promise<FakeCodeReview> {
  const startedAt = Date.now()
  const violations: string[] = []
  const hits: Record<string, number> = {}
  const requests: Record<FakePlatform, number> = { github: 0, gitlab: 0 }
  const unauthorized: Record<FakePlatform, boolean> = { github: false, gitlab: false }
  const githubMine: FakePr[] = GITHUB_MINE.map((pr) => ({ ...pr, reviews: [...pr.reviews] }))
  const gitlabMine: FakeMr[] = GITLAB_MINE.map((mr) => ({ ...mr, approvedBy: [...mr.approvedBy], reviewers: [...mr.reviewers] }))

  const hit = (key: string) => {
    hits[key] = (hits[key] ?? 0) + 1
  }
  const refuse = (res: ServerResponse, status: number, violation: string) => {
    violations.push(violation)
    json(res, status, { message: 'refused by the fake server' })
  }
  const isoAgo = (minutes: number): string => new Date(startedAt - minutes * 60_000).toISOString()

  // --- GitHub GraphQL -------------------------------------------------------------------
  const decision = (pr: FakePr): string | null => {
    const last = pr.reviews.at(-1)?.state
    if (last === 'APPROVED') return 'APPROVED'
    if (last === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED'
    return pr.reviews.length > 0 || pr.author !== FAKE_GITHUB_LOGIN ? 'REVIEW_REQUIRED' : null
  }

  const prNode = (pr: FakePr) => ({
    __typename: 'PullRequest',
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: githubPrUrl(pr),
    isDraft: pr.draft,
    updatedAt: isoAgo(pr.minutesAgo),
    reviewDecision: decision(pr),
    mergeable: pr.conflicts ? 'CONFLICTING' : 'MERGEABLE',
    repository: { nameWithOwner: pr.repo },
    author: { login: pr.author },
    reviews: { totalCount: pr.reviews.length, nodes: pr.reviews.map((r) => ({ state: r.state, author: { login: r.author } })) },
    commits: { nodes: [{ commit: { statusCheckRollup: pr.checks === null ? null : { state: pr.checks } } }] },
  })

  const github = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requests.github++
    if (req.method !== 'POST') return refuse(res, 405, `github: ${req.method ?? '?'} /graphql`)
    if (req.headers['private-token'] !== undefined) return refuse(res, 400, 'github: PRIVATE-TOKEN header sent to GitHub')
    const auth = req.headers.authorization ?? ''
    if (auth === `Bearer ${FAKE_GITLAB_TOKEN}`) return refuse(res, 401, 'github: the GitLab token was sent to GitHub')
    if (auth !== `Bearer ${FAKE_GITHUB_TOKEN}`) {
      // A wrong token is the user's mistake, not a protocol one: GitHub answers 401.
      if (!auth.startsWith('Bearer ')) violations.push('github: no bearer token')
      hit('github 401')
      return json(res, 401, { message: 'Bad credentials' })
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(res, 415, 'github: body is not JSON')
    let body: { query?: unknown; variables?: Record<string, unknown> }
    try {
      body = JSON.parse(await readBody(req)) as typeof body
    } catch {
      return refuse(res, 400, 'github: unparsable body')
    }
    if (unauthorized.github) {
      hit('github 401')
      return json(res, 401, { message: 'Bad credentials' })
    }
    const query = typeof body.query === 'string' ? body.query : ''
    if (/query Viewer\b/.test(query)) {
      hit('github viewer')
      return json(res, 200, { data: { viewer: { login: FAKE_GITHUB_LOGIN } } })
    }
    if (/query CodeReview\b/.test(query)) {
      hit('github fetch')
      const v = body.variables ?? {}
      if (v['toReview'] !== GITHUB_SEARCHES.toReview || v['mine'] !== GITHUB_SEARCHES.mine || v['unreviewed'] !== GITHUB_SEARCHES.unreviewed) {
        return refuse(res, 400, 'github: unexpected search strings')
      }
      if (v['first'] !== 20) return refuse(res, 400, 'github: list limit is not 20')
      const unreviewed = githubMine.filter((pr) => !pr.draft && pr.reviews.length === 0).length
      return json(res, 200, {
        data: {
          viewer: { login: FAKE_GITHUB_LOGIN },
          toReview: { issueCount: GITHUB_TO_REVIEW.length, nodes: GITHUB_TO_REVIEW.map(prNode) },
          mine: { issueCount: githubMine.length, nodes: githubMine.map(prNode) },
          unreviewed: { issueCount: unreviewed },
        },
      })
    }
    return refuse(res, 400, 'github: unknown query')
  }

  // --- GitLab REST ----------------------------------------------------------------------
  const userRef = (username: string) => ({ id: gitlabUserId(username), username, name: username, state: 'active' })

  const mrJson = (mr: FakeMr) => ({
    id: mr.projectId * 1000 + mr.iid,
    iid: mr.iid,
    project_id: mr.projectId,
    title: mr.draft ? `Draft: ${mr.title}` : mr.title,
    state: 'opened',
    created_at: isoAgo(mr.minutesAgo + 60),
    updated_at: isoAgo(mr.minutesAgo),
    web_url: gitlabMrUrl(mr),
    references: { short: `!${mr.iid}`, relative: `!${mr.iid}`, full: gitlabRef(mr) },
    author: userRef(mr.author),
    draft: mr.draft,
    work_in_progress: mr.draft,
    has_conflicts: mr.conflicts,
    detailed_merge_status: mr.conflicts ? 'conflict' : mr.draft ? 'draft_status' : 'mergeable',
    head_pipeline: mr.pipeline === null ? null : { id: mr.iid * 10, status: mr.pipeline },
  })

  const gitlab = (req: IncomingMessage, url: URL, res: ServerResponse): void => {
    requests.gitlab++
    if (req.method !== 'GET') return refuse(res, 405, `gitlab: ${req.method ?? '?'} ${url.pathname}`)
    if (req.headers.authorization !== undefined) return refuse(res, 400, 'gitlab: Authorization header sent to GitLab')
    const token = req.headers['private-token']
    if (token === FAKE_GITHUB_TOKEN) return refuse(res, 401, 'gitlab: the GitHub token was sent to GitLab')
    if (token !== FAKE_GITLAB_TOKEN) {
      if (token === undefined) violations.push('gitlab: no PRIVATE-TOKEN header')
      hit('gitlab 401')
      return json(res, 401, { message: '401 Unauthorized' })
    }
    if (unauthorized.gitlab) {
      hit('gitlab 401')
      return json(res, 401, { message: '401 Unauthorized' })
    }
    const path = url.pathname.slice('/api/v4/'.length)
    const q = url.searchParams

    if (path === 'user') {
      hit('gitlab user')
      return json(res, 200, { ...userRef(FAKE_GITLAB_USER.username), id: FAKE_GITLAB_USER.id, web_url: `${FAKE_GITLAB_ORIGIN}/${FAKE_GITLAB_USER.username}` })
    }
    if (path === 'merge_requests') {
      if (q.get('state') !== 'opened' || q.get('per_page') !== '20') return refuse(res, 400, 'gitlab: list not opened/20')
      if (q.get('scope') === 'created_by_me' && !q.has('reviewer_id')) {
        hit('gitlab mine')
        return json(res, 200, gitlabMine.map(mrJson))
      }
      if (q.get('scope') === 'all' && q.get('reviewer_id') === String(FAKE_GITLAB_USER.id)) {
        hit('gitlab toReview')
        return json(res, 200, GITLAB_TO_REVIEW.map(mrJson))
      }
      return refuse(res, 400, `gitlab: unexpected merge_requests query ${q.toString()}`)
    }
    const perMr = /^projects\/(\d+)\/merge_requests\/(\d+)\/(approvals|reviewers)$/.exec(path)
    if (perMr) {
      const kind = perMr[3] as 'approvals' | 'reviewers'
      hit(`gitlab ${kind}`)
      const mr = gitlabMine.find((m) => m.projectId === Number(perMr[1]) && m.iid === Number(perMr[2]))
      if (!mr) return refuse(res, 404, 'gitlab: per-MR call for an MR that is not the user’s')
      if (mr.draft) violations.push('gitlab: per-MR call for a draft')
      if (kind === 'approvals') {
        return json(res, 200, {
          id: mr.projectId * 1000 + mr.iid,
          iid: mr.iid,
          project_id: mr.projectId,
          approved: mr.approvedBy.length > 0,
          approvals_required: 1,
          approvals_left: mr.approvedBy.length > 0 ? 0 : 1,
          approved_by: mr.approvedBy.map((username) => ({ user: userRef(username) })),
        })
      }
      return json(
        res,
        200,
        mr.reviewers.map((r) => ({ user: userRef(r.username), state: r.state, created_at: isoAgo(mr.minutesAgo) })),
      )
    }
    return refuse(res, 404, `gitlab: unknown path ${path}`)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handle = async (): Promise<void> => {
      if (url.pathname === '/graphql') return github(req, res)
      if (url.pathname.startsWith('/api/v4/')) return gitlab(req, url, res)
      return refuse(res, 404, `unknown route ${req.method ?? '?'} ${url.pathname}`)
    }
    handle().catch(() => {
      if (!res.headersSent) json(res, 500, { message: 'fake server failure' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  const githubState = { approved: 'APPROVED', changes: 'CHANGES_REQUESTED', commented: 'COMMENTED' } as const
  const gitlabState = { approved: 'approved', changes: 'requested_changes', commented: 'reviewed' } as const

  return {
    base: `http://127.0.0.1:${port}`,
    unauthorized,
    violations,
    hits,
    requests,
    reviewPr(id, review, by = 'rosa-ejemplo') {
      const pr = githubMine.find((p) => p.id === id)
      if (!pr) throw new Error(`no own PR ${id}`)
      pr.reviews.push({ state: githubState[review], author: by })
      pr.minutesAgo = -(Date.now() - startedAt) / 60_000
    },
    reviewMr(iid, review, by = 'luis.prueba') {
      const mr = gitlabMine.find((m) => m.iid === iid)
      if (!mr) throw new Error(`no own MR !${iid}`)
      if (review === 'approved') mr.approvedBy.push(by)
      mr.reviewers = [...mr.reviewers.filter((r) => r.username !== by), { username: by, state: gitlabState[review] }]
      mr.minutesAgo = -(Date.now() - startedAt) / 60_000
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
