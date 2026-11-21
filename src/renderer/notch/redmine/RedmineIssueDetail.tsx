import { ArrowLeft, Check, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { localDate } from '../../../shared/code-review/contributions'
import type { MessageKey } from '../../../shared/i18n/messages'
import { REDMINE_COMMENT_MAX, type RedmineActivity, type RedmineIssue, type RedmineIssueDetail as Detail } from '../../../shared/redmine/schema'
import type { Language } from '../../../shared/settings/schema'
import { shownStatus, statusChoices, writeRefusal, type WriteRefusal } from '../../shared/redmine/detail'
import { hoursLong, parseHours, spentLine } from '../../shared/redmine/format'
import { locale } from '../../shared/locale'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'

/** The write a task-section refusal answers, so Retry repeats it. */
type TaskWrite = { readonly kind: 'status'; readonly statusId: number } | { readonly kind: 'estimate' }

/**
 * What a write left in its section: a refusal (Retry, when offered, repeats it with the section's
 * current values; editing a field of the section clears it) or a done line.
 */
type Feedback<Write> = { readonly kind: 'error'; readonly refusal: WriteRefusal; readonly write: Write } | { readonly kind: 'done'; readonly text: string } | null

type FieldErrors = Partial<Record<'estimate' | 'date' | 'hours' | 'activity', MessageKey | undefined>>

/** Hours for a field: the language's decimal mark, no grouping ("1,5", "1500"). */
/** A local `YYYY-MM-DD` day key as a local Date (noon, so no DST edge moves it to another day). */
const dayDate = (key: string): Date => {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}
/** The log date as the field shows it: day and month, "20/11" (ES) / "11/20" (EN). */
const shortDay = (key: string, language: Language): string =>
  new Intl.DateTimeFormat(locale(language), { day: '2-digit', month: '2-digit' }).format(dayDate(key))
/** The log date in full for its accessible name: "20 de noviembre de 2026". */
const longDay = (key: string, language: Language): string =>
  new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'long', year: 'numeric' }).format(dayDate(key))
/** The day key `step` days after `key` (negative: before). */
const shiftDay = (key: string, step: number): string => {
  const day = dayDate(key)
  day.setDate(day.getDate() + step)
  return localDate(day)
}

const fieldHours = (hours: number | null, language: Language): string =>
  hours === null ? '' : new Intl.NumberFormat(locale(language), { maximumFractionDigits: 2, useGrouping: false }).format(hours)

/** A card's title: the caps label (a `<label>` when it names the card's one control). */
const caps = 'flex h-4 shrink-0 items-center text-caps font-medium uppercase text-graphite'

/**
 * The detail's controls: the `.field` pill of the notch's forms, 32 px tall so the three cards fit
 * the capsule. Numbers (estimate, date, hours) are Geist Mono.
 */
const control =
  'field h-8 min-w-0 px-3 text-body text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-select aria-invalid:border-fail/60'
const mono = 'font-mono text-small tabular'
const select = `${control} cursor-pointer [color-scheme:dark] aria-disabled:cursor-default aria-disabled:opacity-40`

/** The detail's buttons, as tall as its controls: the quiet `.btn` (Guardar, Abrir en Redmine) and the primary one (Imputar). */
const busy = 'aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:[filter:none]'
const quietButton = `btn h-8 shrink-0 px-3 ${busy}`
const mainButton = `btn btn-primary h-8 shrink-0 ${busy}`

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
      <p role="status" data-testid={`${testId}-done`} className="mr-auto flex min-w-0 items-center gap-1 text-label text-[color:var(--int,var(--color-ok))]">
        <Check size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">{feedback.text}</span>
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

/** Placeholder cards while the issue loads; the pulse stops with reduced motion. */
function DetailSkeleton() {
  const t = useT()
  const bar = 'animate-pulse rounded-control bg-veil-tile motion-reduce:animate-none'
  return (
    <div data-testid="redmine-detail-loading" aria-busy="true" className="flex flex-col gap-2">
      <p role="status" className="sr-only">
        {t('redmine.detail.loading')}
      </p>
      <div aria-hidden="true" className="grid grid-cols-2 gap-2">
        {[0, 1].map((index) => (
          <div key={index} className="card flex h-[92px] flex-col gap-2 px-3 py-2.5">
            <span className={`h-2.5 w-1/3 ${bar}`} />
            <span className={`h-8 w-full ${bar}`} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="card flex h-[150px] flex-col gap-2 px-3 py-2.5">
        <span className={`h-2.5 w-1/4 ${bar}`} />
        <span className={`h-8 w-full ${bar}`} />
        <span className={`h-8 w-full ${bar}`} />
      </div>
    </div>
  )
}

/**
 * One issue, taking the whole Redmine view: a header "← #id subject" (← and Esc go back to the
 * search), then two cards side by side, its status (a select of the statuses Redmine allows) and its
 * estimate (a field with Guardar, and the hours already logged under it: "12,5 h imputadas de 6 h",
 * in Rojo Fallo past the estimate), and "Imputar horas" (date, today by default and never future;
 * hours; activity, Redmine's default preselected; comment; Ctrl+Enter logs). The controls carry no
 * visible label but the cards' titles: each is named for assistive tech. Every write answers
 * inline: "Redmine no te deja hacer este cambio" (403), "La tarea ya no existe o no tienes acceso"
 * (404), Redmine's own validation messages (422), or a transport failure with Retry. A success reads
 * the issue again before the section is free (main has already refreshed the list, today's hours and
 * the summary), so the select never keeps a status Redmine did not apply and the logged hours follow.
 */
export function RedmineIssueDetail({
  id,
  issue,
  now,
  dimmed,
  onBack,
  onIssue,
  ref,
}: {
  id: number
  /** The row the detail was opened from, shown while the detail loads (or when it fails). */
  issue: RedmineIssue | undefined
  now: Date
  dimmed: boolean
  /** ← in the header: back to the search, on the issue's row. */
  onBack: () => void
  /** Each successful read of the issue (a stable function: it is a dependency of the read). */
  onIssue?: (issue: Detail) => void
  ref?: Ref<HTMLDivElement>
}) {
  const t = useT()
  const language = useLanguage()
  const ids = useId()
  const today = localDate(now)
  const dateInput = useRef<HTMLInputElement>(null)

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
    if (issueResult.ok) {
      setDetail(issueResult.data)
      onIssue?.(issueResult.data)
    }
    if (activitiesResult.ok) {
      setActivities(activitiesResult.data)
      setActivityId((previous) => previous ?? (activitiesResult.data.find((a) => a.isDefault) ?? activitiesResult.data[0])?.id ?? null)
    }
    setLoadFailed(!issueResult.ok || !activitiesResult.ok)
  }, [id, onIssue])

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
  // Against the saved estimate, not the one being typed.
  const spent = detail ? spentLine(detail.spentHours, detail.estimatedHours, language) : null

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

  const logErrors = errors.date !== undefined || errors.hours !== undefined || errors.activity !== undefined

  return (
    <div
      ref={ref}
      role="region"
      aria-label={t('redmine.detail.region', { id })}
      data-testid="redmine-detail"
      data-issue-id={id}
      data-dimmed={dimmed || undefined}
      tabIndex={-1}
      className="flex min-h-0 flex-col gap-1.5 outline-none"
    >
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="redmine-back"
          onClick={onBack}
          aria-label={t('redmine.view.backToList')}
          title={t('redmine.view.backToList')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {/* Subjects are always plain text: React escapes them. */}
        <h2 className="ml-2 flex min-w-0 flex-1 items-baseline gap-2" title={shown?.subject}>
          <span data-testid="redmine-detail-id" className="shrink-0 font-mono text-label text-graphite">
            #{id}
          </span>
          <span data-testid="redmine-detail-subject" className="min-w-0 truncate text-body font-medium text-chalk">
            {shown?.subject ?? ''}
          </span>
        </h2>
      </header>

      <div className={`-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1 pb-0.5 transition-opacity duration-150 ${dimmed ? 'opacity-70' : ''}`}>
        {detail === null || activities === null ? (
          loadFailed ? (
            <p role="alert" data-testid="redmine-detail-error" className="flex min-h-8 flex-wrap items-center gap-x-1 px-1.5 text-small">
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
            <DetailSkeleton />
          )
        ) : (
          <>
            <div className="grid shrink-0 grid-cols-2 items-stretch gap-2">
              <div data-testid="redmine-card-status" className="card flex min-w-0 flex-col gap-2 px-3 py-2.5">
                <label htmlFor={`${ids}-status`} className={caps}>
                  {t('redmine.detail.status')}
                </label>
                <select
                  id={`${ids}-status`}
                  data-testid="redmine-detail-status"
                  value={statusId ?? ''}
                  // aria-disabled, not disabled: a disabled control drops focus to <body>, where Esc would close the notch.
                  aria-disabled={taskBusy}
                  aria-busy={taskBusy || undefined}
                  onChange={(event) => changeStatus(Number(event.target.value))}
                  className={`${select} w-full`}
                >
                  {statuses.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.name}
                    </option>
                  ))}
                </select>
              </div>

              <div data-testid="redmine-card-estimate" className="card flex min-w-0 flex-col gap-2 px-3 pb-2 pt-2.5">
                <label htmlFor={`${ids}-estimate`} className={caps}>
                  {t('redmine.detail.estimate')}
                </label>
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    id={`${ids}-estimate`}
                    type="text"
                    inputMode="text"
                    data-testid="redmine-detail-estimate"
                    value={estimate}
                    maxLength={10}
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
                    className={`${control} ${mono} w-1/2 text-center`}
                  />
                  <button type="button" data-testid="redmine-detail-estimate-save" aria-disabled={taskBusy} onClick={saveEstimate} className={quietButton}>
                    {t('redmine.detail.save')}
                  </button>
                </div>
                {/* The hours logged and the last save's line (or the estimate's error): both always
                    there (16 px each), so a save never shifts the cards. */}
                <div className="flex min-w-0 flex-col">
                  <p
                    data-testid="redmine-detail-spent"
                    data-over={spent?.over || undefined}
                    className={`flex h-4 min-w-0 items-center truncate text-label tabular ${spent?.over ? 'text-fail' : 'text-graphite'}`}
                  >
                    {spent?.text}
                  </p>
                  <div className="flex h-4 min-w-0 items-center">
                    {errors.estimate ? (
                      <FieldError id={`${ids}-estimate-error`} messageKey={errors.estimate} />
                    ) : (
                      <WriteFeedback feedback={taskFeedback} onRetry={retryTask} testId="redmine-detail-task" />
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div onKeyDown={onLogKeyDown} data-testid="redmine-log" className="card flex shrink-0 flex-col gap-2 px-3 pb-2.5 pt-2.5">
              <h3 className={caps}>{t('redmine.detail.logTime')}</h3>
              <div className="flex min-w-0 items-center gap-2">
                {/* The date shows short ("20/11", day and month in the language's order) on a button
                    that opens the native picker; the native input underneath holds the value and the
                    limit (never a future day). ↑/↓ move one day. */}
                <span className="relative shrink-0">
                  <button
                    type="button"
                    data-testid="redmine-log-date-button"
                    aria-label={`${t('redmine.detail.date')}: ${longDay(date, language)}`}
                    {...field('date')}
                    onClick={() => dateInput.current?.showPicker?.()}
                    onKeyDown={(event) => {
                      const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
                      if (step === 0) return
                      event.preventDefault()
                      const next = shiftDay(date, step)
                      if (next > today) return
                      setDate(next)
                      editLog('date')
                    }}
                    className={`${control} ${mono} relative z-10 w-[68px] cursor-pointer px-2.5 text-center`}
                  >
                    {shortDay(date, language)}
                  </button>
                  <input
                    ref={dateInput}
                    id={`${ids}-date`}
                    type="date"
                    data-testid="redmine-log-date"
                    tabIndex={-1}
                    aria-hidden="true"
                    value={date}
                    max={today}
                    required
                    onChange={(event) => {
                      if (!event.target.value) return
                      setDate(event.target.value)
                      editLog('date')
                    }}
                    className="pointer-events-none absolute inset-0 opacity-0 [color-scheme:dark]"
                  />
                </span>
                <input
                  id={`${ids}-hours`}
                  type="text"
                  inputMode="text"
                  data-testid="redmine-log-hours"
                  aria-label={t('redmine.detail.hours')}
                  value={hours}
                  maxLength={10}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="h"
                  title={t('redmine.detail.hoursFormats')}
                  {...field('hours')}
                  onChange={(event) => {
                    setHours(event.target.value)
                    editLog('hours')
                  }}
                  className={`${control} ${mono} w-[84px] shrink-0 px-2 text-center`}
                />
                <select
                  id={`${ids}-activity`}
                  data-testid="redmine-log-activity"
                  aria-label={t('redmine.detail.activity')}
                  value={activityId ?? ''}
                  {...field('activity')}
                  onChange={(event) => {
                    setActivityId(Number(event.target.value))
                    editLog('activity')
                  }}
                  className={`${select} flex-1`}
                >
                  {activities.map((activity) => (
                    <option key={activity.id} value={activity.id}>
                      {activity.name}
                    </option>
                  ))}
                </select>
              </div>
              {logErrors && (
                <div className="-mt-1 flex min-w-0 flex-wrap gap-x-3 px-1">
                  <FieldError id={`${ids}-date-error`} messageKey={errors.date} />
                  <FieldError id={`${ids}-hours-error`} messageKey={errors.hours} />
                  <FieldError id={`${ids}-activity-error`} messageKey={errors.activity} />
                </div>
              )}
              <input
                id={`${ids}-comment`}
                type="text"
                data-testid="redmine-log-comment"
                aria-label={t('redmine.detail.comment')}
                value={comment}
                maxLength={REDMINE_COMMENT_MAX}
                autoComplete="off"
                placeholder={t('redmine.detail.comment')}
                onChange={(event) => {
                  setComment(event.target.value)
                  editLog(null)
                }}
                className={`${control} w-full`}
              />
              <div className="flex min-h-8 min-w-0 items-center gap-2">
                <WriteFeedback feedback={logFeedback} onRetry={() => void logTime()} testId="redmine-log" />
                <button type="button" data-testid="redmine-detail-open" onClick={() => void window.notch.redmine.open({ id })} className={`${quietButton} ml-auto`}>
                  {t('redmine.detail.open')}
                  <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  data-testid="redmine-log-submit"
                  // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would close the notch.
                  aria-disabled={logBusy}
                  onClick={() => void logTime()}
                  className={mainButton}
                >
                  {t('redmine.detail.submit')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
