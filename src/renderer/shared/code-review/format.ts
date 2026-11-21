import type { CodeReviewAlert, CodeReviewState, Platform, PlatformState } from '../../../shared/code-review/schema'
import { translate } from '../../../shared/i18n/messages'
import type { Language } from '../../../shared/settings/schema'

/** Whether the alert a click was about is still the one on screen (not spent, replaced or unmounted). */
export function alertStillShown(clicked: CodeReviewAlert | null, current: CodeReviewAlert | null | undefined): boolean {
  return clicked !== null && clicked === current
}

/** Platforms in capsule order. */
export const PLATFORMS: readonly Platform[] = ['github', 'gitlab']

/** Brand names are never translated. */
export const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { github: 'GitHub', gitlab: 'GitLab' }

/** What the first-review alert shows: the verdict of one PR/MR (with its ref and title when known), or a count. */
export type ReviewAlertContent =
  | { kind: 'single'; verdict: string; ref: string | null; title: string | null }
  | { kind: 'many'; text: string; platform: string }

const VERDICTS = { approved: 'codeReview.alert.approved', changes: 'codeReview.alert.changes', commented: 'codeReview.alert.commented' } as const

const present = (text: string | undefined): string | null => (text === undefined || text.trim() === '' ? null : text)

/** "Aprobado · web#12 · Fix login" for one (the repository's name, not its owner); "2 PR revisados · GitHub" for several. */
export function reviewAlertContent(alert: CodeReviewAlert, language: Language): ReviewAlertContent {
  if (alert.count > 1) {
    const key = alert.platform === 'github' ? 'codeReview.alert.manyPr' : 'codeReview.alert.manyMr'
    return { kind: 'many', text: translate(language, key, { count: alert.count }), platform: PLATFORM_NAMES[alert.platform] }
  }
  return {
    kind: 'single',
    verdict: translate(language, VERDICTS[alert.kind ?? 'commented']),
    ref: present(alert.ref) === null ? null : shortRef((alert.ref ?? '').trim()),
    title: present(alert.title),
  }
}

/** Accessible name of the alert: the same text, with the platform in front of a single verdict. */
export function reviewAlertLabel(alert: CodeReviewAlert, language: Language): string {
  const content = reviewAlertContent(alert, language)
  if (content.kind === 'many') return `${content.text} · ${content.platform}`
  const parts = [content.verdict, content.ref, content.title].filter((part): part is string => part !== null)
  return `${PLATFORM_NAMES[alert.platform]}: ${parts.join(' · ')}`
}

/**
 * The row under the contributions: the account, with the server in front on GitLab (`gitlabUrl`
 * given, no `https://`); null without an account. GitHub passes an empty `gitlabUrl`.
 */
export function profileRow(state: PlatformState, gitlabUrl: string): { label: string } | null {
  if (state.status === 'unconfigured' || state.account === null || state.account === '') return null
  const server = gitlabUrl.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return { label: server === '' ? state.account : `${server} · ${state.account}` }
}

/** Platforms with a token (any status but `unconfigured`), GitHub first: the view opens on the first one when no platform was asked for. */
export function configuredPlatforms(state: CodeReviewState | null): Platform[] {
  if (!state) return []
  return PLATFORMS.filter((platform) => state[platform].status !== 'unconfigured')
}

/**
 * The platform the view shows: the one asked for (a tile or the alert), even when it is not
 * configured (its tile then shows "sin configurar"), else the first configured one, else GitHub.
 */
export function reviewsPlatform(target: Platform | null, configured: readonly Platform[]): Platform {
  return target ?? configured[0] ?? 'github'
}

export type ReviewsBody = 'loading' | 'unconfigured' | 'auth' | 'contributions'

/** What the body shows for one platform: a notice, or its contributions (offline keeps the last ones). */
export function reviewsBody(platform: PlatformState | null): ReviewsBody {
  if (!platform) return 'loading'
  if (platform.status === 'unconfigured') return 'unconfigured'
  if (platform.status === 'auth-error') return 'auth'
  return 'contributions'
}

/** `owner/repo#123` → repo path and `#123` (GitLab `!45`), so the number survives truncation. */
export function splitRef(ref: string): { repo: string; number: string } {
  const match = /^(.*?)([#!]\d+)$/.exec(ref)
  return match ? { repo: match[1] ?? '', number: match[2] ?? '' } : { repo: ref, number: '' }
}

/** The repository's own name and the number ("web-frontend#1234"), as the alert shows a ref. */
export function shortRef(ref: string): string {
  const { repo, number } = splitRef(ref)
  if (number === '') return ref
  const name = repo.split('/').filter((part) => part !== '').pop() ?? repo
  return `${name}${number}`
}
