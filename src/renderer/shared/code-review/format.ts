import {
  CODE_REVIEW_COUNT_CAP,
  type CodeReviewAlert,
  type CodeReviewList,
  type CodeReviewState,
  type Platform,
  type PlatformState,
  type ReviewItem,
} from '../../../shared/code-review/schema'
import { translate, type MessageKey } from '../../../shared/i18n/messages'
import type { Language } from '../../../shared/settings/schema'

/** Platforms in tab and capsule order. */
export const PLATFORMS: readonly Platform[] = ['github', 'gitlab']

/** Brand names are never translated. */
export const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { github: 'GitHub', gitlab: 'GitLab' }

/** A count as shown: main caps it at 100, which means "more than 99". */
export function reviewCountText(count: number): string {
  return count >= CODE_REVIEW_COUNT_CAP ? '99+' : String(count)
}

/** Accessible name of a capsule block: "2 PR tuyos sin revisar en GitHub" / "1 of your MRs unreviewed on GitLab". */
export function unreviewedLabel(platform: Platform, count: number, language: Language): string {
  const github = platform === 'github'
  if (count === 1) return translate(language, github ? 'codeReview.capsule.unreadPrOne' : 'codeReview.capsule.unreadMrOne')
  return translate(language, github ? 'codeReview.capsule.unreadPr' : 'codeReview.capsule.unreadMr', { count: reviewCountText(count) })
}

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

export type ReviewSection = 'toReview' | 'mine'

export type BadgeKey = 'draft' | 'approved' | 'changes' | 'unreviewed' | 'conflicts' | 'checksPass' | 'checksFail' | 'checksRunning'
export type BadgeTone = 'neutral' | 'ok' | 'wait' | 'fail' | 'ice'

export interface Badge {
  key: BadgeKey
  tone: BadgeTone
}

export const BADGE_TEXT: Readonly<Record<BadgeKey, MessageKey>> = {
  draft: 'codeReview.badge.draft',
  approved: 'codeReview.badge.approved',
  changes: 'codeReview.badge.changes',
  unreviewed: 'codeReview.badge.unreviewed',
  conflicts: 'codeReview.badge.conflicts',
  checksPass: 'codeReview.badge.checksPass',
  checksFail: 'codeReview.badge.checksFail',
  checksRunning: 'codeReview.badge.checksRunning',
}

/** Accessible names that differ from the visible text (the ✓ / ✗ marks). */
export const BADGE_LABEL: Readonly<Partial<Record<BadgeKey, MessageKey>>> = {
  checksPass: 'codeReview.badge.checksPassLabel',
  checksFail: 'codeReview.badge.checksFailLabel',
}

/**
 * The labels of a row, in reading order: draft or review state, then conflicts and checks.
 * "Sin revisar" only on own, non-draft PR/MRs without any review (what the capsule counts); a
 * comment-only review gets no label.
 */
export function itemBadges(item: ReviewItem, section: ReviewSection): Badge[] {
  const badges: Badge[] = []
  if (item.draft) badges.push({ key: 'draft', tone: 'neutral' })
  if (item.review === 'approved') badges.push({ key: 'approved', tone: 'ok' })
  else if (item.review === 'changes') badges.push({ key: 'changes', tone: 'wait' })
  else if (item.review === 'none' && section === 'mine' && !item.draft) badges.push({ key: 'unreviewed', tone: 'ice' })
  if (item.conflicts) badges.push({ key: 'conflicts', tone: 'fail' })
  if (item.checks === 'pass') badges.push({ key: 'checksPass', tone: 'ok' })
  else if (item.checks === 'fail') badges.push({ key: 'checksFail', tone: 'fail' })
  else if (item.checks === 'running') badges.push({ key: 'checksRunning', tone: 'neutral' })
  return badges
}

/** Platforms with a token (any status but `unconfigured`), GitHub first: the view's tabs. */
export function configuredPlatforms(state: CodeReviewState | null): Platform[] {
  if (!state) return []
  return PLATFORMS.filter((platform) => state[platform].status !== 'unconfigured')
}

export type ReviewsBody = 'loading' | 'unconfigured' | 'auth' | 'empty' | 'list'

/**
 * What the body shows for one platform. Offline keeps the last lists (dimmed); offline with empty
 * lists is only "empty" after a past successful query, otherwise nothing is known yet.
 */
export function reviewsBody(platform: PlatformState | null, list: CodeReviewList | null): ReviewsBody {
  if (!platform) return 'loading'
  if (platform.status === 'unconfigured') return 'unconfigured'
  if (platform.status === 'auth-error') return 'auth'
  if (!list) return 'loading'
  if (list.toReview.length > 0 || list.mine.length > 0) return 'list'
  if (platform.status === 'offline' && platform.updatedAt === null) return 'loading'
  return 'empty'
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
