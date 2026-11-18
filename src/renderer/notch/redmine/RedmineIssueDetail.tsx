import { ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { localDate } from '../../../shared/code-review/contributions'
import type { MessageKey } from '../../../shared/i18n/messages'
import { REDMINE_COMMENT_MAX, type RedmineActivity, type RedmineIssue, type RedmineIssueDetail as Detail } from '../../../shared/redmine/schema'
import type { Language } from '../../../shared/settings/schema'
import { shownStatus, statusChoices, writeRefusal, type WriteRefusal } from '../../shared/redmine/detail'
import { hoursLong, parseHours } from '../../shared/redmine/format'
import { locale } from '../../shared/locale'
import { useLanguage, useT } from '../../shared/use-t'
import { fieldClass, primaryButton } from '../reminders/styles'

/** The write a task-section refusal answers, so Retry repeats it. */
type TaskWrite = { readonly kind: 'status'; readonly statusId: number } | { readonly kind: 'estimate' }

/**
 * What a write left in its section: a refusal (Retry, when offered, repeats it with the section's
 * current values; editing a field of the section clears it) or a done line.
 */
type Feedback<Write> = { readonly kind: 'error'; readonly refusal: WriteRefusal; readonly write: Write } | { readonly kind: 'done'; readonly text: string } | null

type FieldErrors = Partial<Record<'estimate' | 'date' | 'hours' | 'activity', MessageKey | undefined>>

/** Hours for a field: the language's decimal mark, no grouping ("1,5", "1500"). */
const fieldHours = (hours: number | null, language: Language): string =>
  hours === null ? '' : new Intl.NumberFormat(locale(language), { maximumFractionDigits: 2, useGrouping: false }).format(hours)

const caps = 'flex h-7 shrink-0 items-center text-caps font-medium uppercase text-graphite'

/** One labelled row: label column on the left, the control (and anything beside it) on the right. */
function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <>
      <label htmlFor={htmlFor} className="flex h-[34px] items-center text-label font-medium text-graphite">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </>
  )
}

function FieldError({ id, messageKey }: { id: string; messageKey: MessageKey | undefined }) {
  const t = useT()
  if (!messageKey) return null
  return (
    <p id={id} role="alert" data-testid={id} className="min-w-0 truncate text-label text-fail">
      {t(messageKey)}
    </p>
  )
}

/** A section's last write: the refusal in Rojo Fallo (Redmine's own messages after it), or the done line. */
function WriteFeedback<Write>({ feedback, onRetry, testId }: { feedback: Feedback<Write>; onRetry: () => void; testId: string }) {
  const t = useT()
  if (feedback === null) return null
  if (feedback.kind === 'done')
    return (
      <p role="status" data-testid={`${testId}-done`} className="mr-auto min-w-0 truncate text-label text-ok">
        {feedback.text}
      </p>
    )
  const { refusal } = feedback
  return (
    <p role="alert" data-testid={`${testId}-error`} className="mr-auto flex min-w-0 flex-wrap items-center gap-x-1 text-label">
      {/* Redmine's validation messages are plain text: React escapes them. */}
      <span className="text-fail">{refusal.messages.length > 0 ? refusal.messages.join(' · ') : t(refusal.key)}</span>
      {refusal.retryable && (
        <>
          <span aria-hidden="true" className="text-graphite">
            ·
          </span>
          <button
            type="button"
            data-testid={`${testId}-retry`}
            onClick={onRetry}
            className="-my-1 inline-flex min-h-6 cursor-pointer items-center rounded-control-sm px-1 font-medium text-chalk underline-offset-2 hover:underline"
          >
            {t('redmine.error.retry')}
          </button>
        </>
      )}
    </p>
  )
}

/**
 * One issue inside the Redmine view: its status (a select of the statuses Redmine allows), its
 * estimate (a field with Save) and "Imputar horas" (date, today by default and never future; hours;
 * activity, Redmine's default preselected; comment; Ctrl+Enter logs). Every write answers inline:
 * "Redmine no te deja hacer este cambio" (403), "La tarea ya no existe o no tienes acceso" (404),
 * Redmine's own validation messages (422), or a transport failure with Retry. A success reads the
 * issue again before the section is free (main has already refreshed the list, today's hours and the
 * summary), so the select never keeps a status Redmine did not apply.
 */
export function RedmineIssueDetail({
  id,
  issue,
  now,
  dimmed,
  ref,
}: {
  id: number
  /** The row from the list, shown while the detail loads (or when it fails). */
  issue: RedmineIssue | undefined
  now: Date
  dimmed: boolean
  ref?: Ref<HTMLDivElement>
}) {
  const t = useT()
  const language = useLanguage()
  const ids = useId()
  const today = localDate(now)

  const [detail, setDetail] = useState<Detail | null>(null)
  const [activities, setActivities] = useState<readonly RedmineActivity[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const [statusDraft, setStatusDraft] = useState<number | null>(null)
  const [estimateText, setEstimateText] = useState<string | null>(null)
  const [taskBusy, setTaskBusy] = useState(false)
  const [taskFeedback, setTaskFeedback] = useState<Feedback<TaskWrite>>(null)

  const [date, setDate] = useState(today)
  const [hours, setHours] = useState('')
  const [activityId, setActivityId] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [logBusy, setLogBusy] = useState(false)
  const [logFeedback, setLogFeedback] = useState<Feedback<'log'>>(null)
  const [errors, setErrors] = useState<FieldErrors>({})

  // Only the newest read applies; unmounting ends them all.
  const reads = useRef(0)

  /** The issue and the activities (main caches them per session); a failure keeps what was shown. */
  const load = useCallback(async () => {
    const read = ++reads.current
    const [issueResult, activitiesResult] = await Promise.all([window.notch.redmine.issue({ id }), window.notch.redmine.activities()])
    if (read !== reads.current) return
    if (issueResult.ok) setDetail(issueResult.data)
    if (activitiesResult.ok) {
      setActivities(activitiesResult.data)
      setActivityId((previous) => previous ?? (activitiesResult.data.find((a) => a.isDefault) ?? activitiesResult.data[0])?.id ?? null)
    }
    setLoadFailed(!issueResult.ok || !activitiesResult.ok)
  }, [id])

  useEffect(() => {
    void load()
    const all = reads
    return () => {
      all.current += 1
    }
  }, [load])

  const shown = detail ?? issue
  const statusId = shownStatus(statusDraft, taskBusy, detail?.status.id ?? null)
  const statuses = detail ? statusChoices(detail) : []
  const estimate = estimateText ?? fieldHours(detail?.estimatedHours ?? null, language)

  /** One task write: busy until the issue is read again after a success, so the select shows Redmine's answer. */
  const writeTask = async (write: TaskWrite, patch: { statusId: number } | { estimatedHours: number | null }) => {
    setTaskBusy(true)
    setTaskFeedback(null)
    const refusal = writeRefusal(await window.notch.redmine.updateIssue({ id, ...patch }))
    if (refusal === null) {
      if (write.kind === 'estimate') setEstimateText(null)
      await load()
    }
    setStatusDraft(null)
    setTaskBusy(false)
    setTaskFeedback(refusal === null ? { kind: 'done', text: t('redmine.detail.saved') } : { kind: 'error', refusal, write })
  }

  const changeStatus = (next: number) => {
    if (taskBusy || detail === null || next === statusId) return
    setStatusDraft(next)
    void writeTask({ kind: 'status', statusId: next }, { statusId: next })
  }

  const saveEstimate = () => {
    if (taskBusy || detail === null) return
    const text = estimate.trim()
    const value = text === '' ? null : parseHours(text)
    if (text !== '' && (value === null || value > 999)) {
      setErrors((e) => ({ ...e, estimate: 'redmine.error.estimate' }))
      return
    }
    void writeTask({ kind: 'estimate' }, { estimatedHours: value })
  }

  // Retry repeats the refused write with what the section holds now (editing a field clears the refusal).
  const retryTask = () => {
    if (taskFeedback?.kind !== 'error') return
    if (taskFeedback.write.kind === 'status') changeStatus(taskFeedback.write.statusId)
    else saveEstimate()
  }

  const logTime = async () => {
    if (logBusy) return
    const value = parseHours(hours)
    const found: FieldErrors = {
      ...(value === null || value <= 0 || value > 24 ? { hours: 'redmine.error.hours' as const } : {}),
      ...(date === '' || date > today ? { date: 'redmine.error.date' as const } : {}),
      ...(activityId === null ? { activity: 'redmine.detail.noActivities' as const } : {}),
    }
    if (Object.keys(found).length > 0 || value === null || activityId === null) {
      setErrors((e) => ({ ...e, ...found }))
      return
    }
    setLogBusy(true)
    setLogFeedback(null)
    const refusal = writeRefusal(await window.notch.redmine.logTime({ issueId: id, spentOn: date, hours: value, activityId, comments: comment.trim() }))
    if (refusal === null) {
      setHours('')
      setComment('')
      await load()
    }
    setLogBusy(false)
    setLogFeedback(refusal === null ? { kind: 'done', text: t('redmine.detail.logged', { hours: hoursLong(value, language) }) } : { kind: 'error', refusal, write: 'log' })
  }

  /** A field of the log form changed: its error and the last write's line no longer apply. */
  const editLog = (name: keyof FieldErrors | null) => {
    if (name !== null) setErrors((e) => ({ ...e, [name]: undefined }))
    setLogFeedback(null)
  }

  // Ctrl+Enter logs from any field of the form.
  const onLogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    void logTime()
  }

  const field = (name: keyof FieldErrors) => ({
    'aria-invalid': errors[name] !== undefined,
    'aria-describedby': errors[name] ? `${ids}-${name}-error` : undefined,
  })

  return (
    <div
      ref={ref}
      role="region"
      aria-label={t('redmine.detail.region', { id })}
      data-testid="redmine-detail"
      data-issue-id={id}
      data-dimmed={dimmed || undefined}
      tabIndex={-1}
      className={`-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 outline-none transition-opacity duration-150 ${dimmed ? 'opacity-70' : ''}`}
    >
      <div className="flex shrink-0 flex-col gap-1 px-1.5 pb-2.5">
        <div className="flex h-6 items-center gap-1.5 text-label text-graphite">
          <span className="tabular shrink-0">#{id}</span>
          {shown && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="redmine-detail-project" className="min-w-0 truncate">
                {shown.project}
              </span>
            </>
          )}
          {shown && shown.spentHours !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="redmine-detail-spent" className="tabular shrink-0">
                {t('redmine.detail.spent', { hours: hoursLong(shown.spentHours, language) })}
              </span>
            </>
          )}
          <button
            type="button"
            data-testid="redmine-detail-open"
            onClick={() => void window.notch.redmine.open({ id })}
            className="-mr-1 ml-auto inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-control-sm px-1.5 font-medium text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk"
          >
            {t('redmine.detail.open')}
            <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        {/* Subjects are always plain text: React escapes them. */}
        <h3 data-testid="redmine-detail-subject" className="line-clamp-2 text-body font-medium leading-[18px] text-chalk">
          {shown?.subject ?? ''}
        </h3>
      </div>

      {detail === null || activities === null ? (
        loadFailed ? (
          <p role="alert" data-testid="redmine-detail-error" className="flex flex-wrap items-center gap-x-1 px-1.5 text-small">
            <span className="text-fail">{t('redmine.detail.loadFailed')}</span>
            <span aria-hidden="true" className="text-graphite">
              ·
            </span>
            <button
              type="button"
              data-testid="redmine-detail-retry"
              onClick={() => void load()}
              className="-my-1 inline-flex min-h-6 cursor-pointer items-center rounded-control-sm px-1 font-medium text-chalk underline-offset-2 hover:underline"
            >
              {t('redmine.error.retry')}
            </button>
          </p>
        ) : (
          <div data-testid="redmine-detail-loading" aria-busy="true" className="flex flex-col gap-3 px-1.5 pt-1">
            <p role="status" className="sr-only">
              {t('redmine.detail.loading')}
            </p>
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} aria-hidden="true" className="h-[34px] w-full animate-pulse rounded-control bg-veil motion-reduce:animate-none" />
            ))}
          </div>
        )
      ) : (
        <>
          <div data-testid="redmine-card-status" className="card grid shrink-0 grid-cols-[84px_minmax(0,1fr)] items-start gap-x-3 px-3 py-1.5">
            <Row label={t('redmine.detail.status')} htmlFor={`${ids}-status`}>
              <select
                id={`${ids}-status`}
                data-testid="redmine-detail-status"
                value={statusId ?? ''}
                // aria-disabled, not disabled: a disabled control drops focus to <body>, where Esc would close the notch.
                aria-disabled={taskBusy}
                aria-busy={taskBusy || undefined}
                onChange={(event) => changeStatus(Number(event.target.value))}
                className={`${fieldClass} w-[220px] min-w-0 cursor-pointer [color-scheme:dark] aria-disabled:cursor-default aria-disabled:opacity-40`}
              >
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            </Row>
          </div>
          <div data-testid="redmine-card-estimate" className="card grid shrink-0 grid-cols-[84px_minmax(0,1fr)] items-start gap-x-3 px-3 py-1.5">
            <Row label={t('redmine.detail.estimate')} htmlFor={`${ids}-estimate`}>
              <input
                id={`${ids}-estimate`}
                type="text"
                inputMode="decimal"
                data-testid="redmine-detail-estimate"
                value={estimate}
                maxLength={6}
                spellCheck={false}
                autoComplete="off"
                placeholder="h"
                {...field('estimate')}
                onChange={(event) => {
                  setEstimateText(event.target.value)
                  setErrors((e) => ({ ...e, estimate: undefined }))
                  setTaskFeedback(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  saveEstimate()
                }}
                className={`${fieldClass} tabular w-[72px] shrink-0 text-center`}
              />
              <button
                type="button"
                data-testid="redmine-detail-estimate-save"
                aria-disabled={taskBusy}
                onClick={saveEstimate}
                className={primaryButton}
              >
                {t('redmine.detail.save')}
              </button>
              <FieldError id={`${ids}-estimate-error`} messageKey={errors.estimate} />
            </Row>
          </div>
          {/* Always mounted (24 px reserved), so saving never shifts the log card. Aligned with the
              fields inside the cards: 1 border + 12 padding + 84 label column + 12 gap = 109 px. */}
          <div className="flex min-h-6 shrink-0 items-center pl-[109px] pr-1.5">
            <WriteFeedback feedback={taskFeedback} onRetry={retryTask} testId="redmine-detail-task" />
          </div>

          <div onKeyDown={onLogKeyDown} data-testid="redmine-log" className="card flex shrink-0 flex-col px-3 pb-2 pt-1">
            <h4 className={caps}>{t('redmine.detail.logTime')}</h4>
            <div className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
              <Row label={t('redmine.detail.date')} htmlFor={`${ids}-date`}>
                <input
                  id={`${ids}-date`}
                  type="date"
                  data-testid="redmine-log-date"
                  value={date}
                  max={today}
                  required
                  {...field('date')}
                  onChange={(event) => {
                    setDate(event.target.value)
                    editLog('date')
                  }}
                  className={`${fieldClass} tabular w-[136px] shrink-0 [color-scheme:dark]`}
                />
                <FieldError id={`${ids}-date-error`} messageKey={errors.date} />
              </Row>
              <Row label={t('redmine.detail.hours')} htmlFor={`${ids}-hours`}>
                <input
                  id={`${ids}-hours`}
                  type="text"
                  inputMode="decimal"
                  data-testid="redmine-log-hours"
                  value={hours}
                  maxLength={5}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="h"
                  {...field('hours')}
                  onChange={(event) => {
                    setHours(event.target.value)
                    editLog('hours')
                  }}
                  className={`${fieldClass} tabular w-[72px] shrink-0 text-center`}
                />
                <FieldError id={`${ids}-hours-error`} messageKey={errors.hours} />
              </Row>
              <Row label={t('redmine.detail.activity')} htmlFor={`${ids}-activity`}>
                <select
                  id={`${ids}-activity`}
                  data-testid="redmine-log-activity"
                  value={activityId ?? ''}
                  {...field('activity')}
                  onChange={(event) => {
                    setActivityId(Number(event.target.value))
                    editLog('activity')
                  }}
                  className={`${fieldClass} w-[220px] min-w-0 cursor-pointer [color-scheme:dark]`}
                >
                  {activities.map((activity) => (
                    <option key={activity.id} value={activity.id}>
                      {activity.name}
                    </option>
                  ))}
                </select>
                <FieldError id={`${ids}-activity-error`} messageKey={errors.activity} />
              </Row>
              <Row label={t('redmine.detail.comment')} htmlFor={`${ids}-comment`}>
                <input
                  id={`${ids}-comment`}
                  type="text"
                  data-testid="redmine-log-comment"
                  value={comment}
                  maxLength={REDMINE_COMMENT_MAX}
                  autoComplete="off"
                  placeholder={t('redmine.detail.commentPlaceholder')}
                  onChange={(event) => {
                    setComment(event.target.value)
                    editLog(null)
                  }}
                  className={`${fieldClass} w-full`}
                />
              </Row>
            </div>
            <div className="mt-2 flex min-h-7 items-center justify-end gap-2">
              <WriteFeedback feedback={logFeedback} onRetry={() => void logTime()} testId="redmine-log" />
              <button
                type="button"
                data-testid="redmine-log-submit"
                // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would close the notch.
                aria-disabled={logBusy}
                onClick={() => void logTime()}
                className={primaryButton}
              >
                {t('redmine.detail.submit')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
