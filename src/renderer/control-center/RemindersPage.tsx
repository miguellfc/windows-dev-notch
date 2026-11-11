import { Pencil, Repeat, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import type { Result } from '../../shared/ipc/result'
import { hasVisibleText, REMINDER_TEXT_MAX, type Reminder } from '../../shared/reminders/schema'
import { SNOOZE_MINUTES_OPTIONS, type Settings } from '../../shared/settings/schema'
import { formatDue, reminderErrorKey } from '../shared/reminders/format'
import { buildDueAt, parseClock } from '../shared/reminders/form'
import { groupReminders, isDraftLive, isoToDueFields } from '../shared/reminders/groups'
import { useInFlight } from '../shared/reminders/use-in-flight'
import { ReminderComposer } from '../shared/reminders/ReminderComposer'
import { NoticeBanner } from '../shared/reminders/RemindersNotice'
import { useReminders } from '../shared/reminders-store'
import { useSettings } from '../shared/settings-store'
import { useClock } from '../shared/use-clock'
import { useLanguage, useT } from '../shared/use-t'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { SettingRow } from './ControlCenterApp'

type Run = (id: string, call: () => Promise<Result<unknown>>) => Promise<boolean>
type RepeatValue = Reminder['repeat']

const REPEAT_OPTIONS: readonly { value: RepeatValue; label: MessageKey }[] = [
  { value: 'none', label: 'reminders.repeat.none' },
  { value: 'daily', label: 'reminders.repeat.optionDaily' },
  { value: 'weekdays', label: 'reminders.repeat.optionWeekdays' },
]

const iconButton =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk disabled:cursor-default disabled:opacity-40'
const textButton =
  'h-7 shrink-0 cursor-pointer rounded-control border border-line bg-veil-tile px-2.5 text-label font-medium text-chalk transition-colors duration-150 hover:bg-[rgba(255,255,255,0.09)] disabled:cursor-default disabled:opacity-40'
const fieldBase =
  'h-9 rounded-control border border-line bg-veil px-3 text-body text-chalk outline-none transition-colors duration-150 focus:border-ice/60 aria-invalid:border-fail/60'
const fieldClass = `${fieldBase} w-full`

function RepeatMark({ repeat }: { repeat: RepeatValue }) {
  const t = useT()
  if (repeat === 'none') return null
  const label = t(repeat === 'daily' ? 'reminders.repeat.daily' : 'reminders.repeat.weekdays')
  return <Repeat size={12} strokeWidth={1.8} role="img" aria-label={label} className="shrink-0 text-graphite" />
}

interface FormErrors {
  text?: MessageKey
  when?: MessageKey
  form?: MessageKey
}

/** Where a failed update's message belongs: next to the field it is about, else under the form. */
function errorsFor(key: MessageKey): FormErrors {
  if (key === 'reminders.error.past') return { when: key }
  if (key === 'reminders.error.tooLong' || key === 'reminders.error.emptyText') return { text: key }
  return { form: key }
}

/** Local check of the date and time fields, by the notch form's rules (main re-checks the past). */
const WHEN_ERRORS: Readonly<Record<'time' | 'date' | 'past', MessageKey>> = {
  time: 'reminders.form.errorTime',
  date: 'reminders.error.invalidDate',
  past: 'reminders.error.past',
}

/**
 * The open edit, held by the page so it survives a row moving between groups (a remount).
 * `initial` is captured when editing starts: "unchanged" is judged against it, not the live reminder.
 */
interface Draft {
  id: string
  text: string
  /** `YYYY-MM-DD` from the date input. */
  date: string
  /** What the user typed in the 24 h time field (`H:mm` or `HH:mm`). */
  time: string
  repeat: RepeatValue
  initial: { text: string; date: string; time: string; repeat: RepeatValue }
  errors: FormErrors
  busy: boolean
}

const startDraft = (reminder: Reminder): Draft => {
  const initial = { text: reminder.text, ...isoToDueFields(reminder.dueAt), repeat: reminder.repeat }
  return { id: reminder.id, ...initial, initial, errors: {}, busy: false }
}

interface Editor {
  draft: Draft | null
  start: (reminder: Reminder) => void
  /** Both are scoped to a draft id: a late response for one reminder never touches another's draft. */
  change: (id: string, patch: Partial<Draft>) => void
  close: (id: string) => void
  /** Set while an update call is in flight; a ref so two submits in one tick cannot both pass. */
  inFlight: { current: boolean }
}

/** Inline edit form: sends only the fields that changed. */
function EditForm({ draft, editor }: { draft: Draft; editor: Editor }) {
  const t = useT()
  const ids = useId()
  const { text, date, time, repeat, errors, initial } = draft
  const id = draft.id
  const change = (patch: Partial<Draft>) => editor.change(id, patch)
  const close = () => editor.close(id)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (editor.inFlight.current) return
    const trimmed = text.trim()
    const patch: { text?: string; dueAt?: string; repeat?: RepeatValue } = {}
    if (!hasVisibleText(trimmed)) return change({ errors: { text: 'reminders.error.emptyText' } })
    if (trimmed.length > REMINDER_TEXT_MAX) return change({ errors: { text: 'reminders.error.tooLong' } })
    if (trimmed !== initial.text) patch.text = trimmed
    // An untouched date is never sent: a due reminder's date is in the past and would be rejected.
    // Normalized: retyping "09:00" as "9:00" is no change (a due reminder's past date would be rejected).
    if (date !== initial.date || (parseClock(time) ?? time) !== initial.time) {
      const due = buildDueAt({ day: 'other', date, time, repeat: 'none' }, new Date())
      if ('error' in due) return change({ errors: { when: WHEN_ERRORS[due.error] } })
      patch.dueAt = due.dueAt.toISOString()
    }
    if (repeat !== initial.repeat) patch.repeat = repeat
    if (Object.keys(patch).length === 0) return close()

    editor.inFlight.current = true
    change({ errors: {}, busy: true })
    try {
      const result = await window.notch.reminders.update({ id, ...patch })
      if (result.ok) return close()
      change({ errors: errorsFor(reminderErrorKey(result.error)), busy: false })
    } catch {
      change({ errors: { form: 'error.generic' }, busy: false })
    } finally {
      editor.inFlight.current = false
    }
  }

  const labelClass = 'mb-1 block text-label text-graphite'
  return (
    <form
      data-testid="reminder-edit"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }}
      className="flex flex-col gap-3 rounded-tile border border-line bg-veil p-3"
    >
      <div>
        <label htmlFor={`${ids}-text`} className={labelClass}>
          {t('cc.reminders.field.text')}
        </label>
        <input
          id={`${ids}-text`}
          type="text"
          autoFocus
          value={text}
          maxLength={REMINDER_TEXT_MAX}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={errors.text !== undefined}
          aria-describedby={errors.text ? `${ids}-text-error` : undefined}
          onChange={(event) => {
            change({ text: event.target.value, errors: {} })
          }}
          className={fieldClass}
        />
        {errors.text && (
          <p id={`${ids}-text-error`} role="alert" className="mt-1 text-small text-fail">
            {t(errors.text)}
          </p>
        )}
      </div>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <span id={`${ids}-when`} className={labelClass}>
            {t('cc.reminders.field.when')}
          </span>
          <div role="group" aria-labelledby={`${ids}-when`} className="flex gap-2">
            <input
              type="date"
              data-testid="reminder-edit-date"
              aria-label={t('reminders.form.date')}
              value={date}
              aria-invalid={errors.when !== undefined}
              aria-describedby={errors.when ? `${ids}-when-error` : undefined}
              onChange={(event) => {
                change({ date: event.target.value, errors: {} })
              }}
              className={`${fieldBase} tabular min-w-0 flex-1 [color-scheme:dark]`}
            />
            <input
              type="text"
              inputMode="numeric"
              data-testid="reminder-edit-time"
              aria-label={t('reminders.form.time')}
              value={time}
              maxLength={5}
              spellCheck={false}
              autoComplete="off"
              placeholder="HH:mm"
              aria-invalid={errors.when !== undefined}
              aria-describedby={errors.when ? `${ids}-when-error` : undefined}
              onChange={(event) => {
                change({ time: event.target.value, errors: {} })
              }}
              className={`${fieldBase} tabular w-[72px] shrink-0 text-center`}
            />
          </div>
          {errors.when && (
            <p id={`${ids}-when-error`} role="alert" data-testid="reminder-edit-when-error" className="mt-1 text-small text-fail">
              {t(errors.when)}
            </p>
          )}
        </div>
        <div className="w-36 shrink-0">
          <label htmlFor={`${ids}-repeat`} className={labelClass}>
            {t('cc.reminders.field.repeat')}
          </label>
          <select
            id={`${ids}-repeat`}
            value={repeat}
            onChange={(event) => change({ repeat: event.target.value as RepeatValue })}
            className={`${fieldClass} cursor-pointer [color-scheme:dark]`}
          >
            {REPEAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {errors.form && (
        <p role="alert" className="text-small text-fail">
          {t(errors.form)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={textButton} onClick={close}>
          {t('cc.reminders.cancel')}
        </button>
        <button type="submit" disabled={draft.busy} className={textButton}>
          {t('cc.reminders.save')}
        </button>
      </div>
    </form>
  )
}

function Row({ reminder, now, run, busy, editor }: { reminder: Reminder; now: Date; run: Run; busy: boolean; editor: Editor }) {
  const t = useT()
  const language = useLanguage()
  const snoozeMinutes = useSettings((state) => state.settings?.reminders.snoozeMinutes ?? 10)
  const attention = reminder.state === 'due' || reminder.state === 'missed'
  const done = reminder.state === 'done'

  if (editor.draft?.id === reminder.id) {
    return (
      <li>
        <EditForm draft={editor.draft} editor={editor} />
      </li>
    )
  }

  const shownAt = done ? (reminder.completedAt ?? reminder.dueAt) : reminder.dueAt
  return (
    <li
      data-testid="reminder-item"
      data-state={reminder.state}
      className={`flex items-center gap-2 rounded-tile px-2.5 py-1.5 ${attention ? 'bg-veil' : 'hover:bg-veil'}`}
    >
      <div className="min-w-0 flex-1">
        <p className={`truncate text-body ${done ? 'text-graphite line-through' : 'text-chalk'}`}>{reminder.text}</p>
        <p className="tabular flex items-center gap-1 text-label text-graphite">
          {attention && (
            <>
              <span className="text-wait">{t(reminder.state === 'missed' ? 'reminders.state.missed' : 'reminders.state.due')}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>{formatDue(new Date(shownAt), now, language)}</span>
          <RepeatMark repeat={reminder.repeat} />
        </p>
      </div>
      {attention && (
        <>
          <button
            type="button"
            className={textButton}
            disabled={busy}
            onClick={() => void run(reminder.id, () => window.notch.reminders.snooze({ id: reminder.id }))}
          >
            {t('reminders.action.snooze', { minutes: snoozeMinutes })}
          </button>
          <button
            type="button"
            className={textButton}
            disabled={busy}
            onClick={() => void run(reminder.id, () => window.notch.reminders.complete({ id: reminder.id }))}
          >
            {t('reminders.action.complete')}
          </button>
        </>
      )}
      {!done && (
        <button
          type="button"
          aria-label={t('reminders.action.editItem', { text: reminder.text })}
          title={t('reminders.action.edit')}
          className={iconButton}
          disabled={busy}
          onClick={() => editor.start(reminder)}
        >
          <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-label={t('reminders.action.deleteItem', { text: reminder.text })}
        title={t('reminders.action.deleteItem', { text: reminder.text })}
        className={iconButton}
        disabled={busy}
        onClick={() => void run(reminder.id, () => window.notch.reminders.delete({ id: reminder.id }))}
      >
        <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </li>
  )
}

function Group({
  title,
  items,
  now,
  run,
  isBusy,
  editor,
}: {
  title: MessageKey
  items: Reminder[]
  now: Date
  run: Run
  isBusy: (id: string) => boolean
  editor: Editor
}) {
  const t = useT()
  const headingId = useId()
  if (items.length === 0) return null
  return (
    <section aria-labelledby={headingId} data-testid="reminder-group">
      <h2 id={headingId} className="mb-1 px-2.5 text-label font-medium uppercase tracking-wide text-graphite">
        {t(title)}
      </h2>
      <ul className="flex flex-col gap-1">
        {items.map((reminder) => (
          <Row key={reminder.id} reminder={reminder} now={now} run={run} busy={isBusy(reminder.id)} editor={editor} />
        ))}
      </ul>
    </section>
  )
}

export function RemindersPage({ settings }: { settings: Settings }) {
  const t = useT()
  const update = useSettings((state) => state.update)
  // Patches start from the latest store value, not this render's prop, so quick changes never send a stale sibling.
  const patchReminders = (patch: Partial<Settings['reminders']>) => {
    const latest = useSettings.getState().settings?.reminders ?? settings.reminders
    void update({ reminders: { ...latest, ...patch } })
  }
  const reminders = useReminders((store) => store.reminders)
  const now = useClock()
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)

  const rowActions = useInFlight()
  const isBusy = (id: string): boolean => rowActions.has(id)

  // One call per reminder at a time: the row's buttons stay disabled until it settles, so a
  // double click on Complete of a repeating reminder cannot skip an occurrence.
  const run: Run = async (id, call) => {
    if (rowActions.has(id)) return false
    setErrorKey(null)
    try {
      const result = await rowActions.run(id, call)
      if (!result) return false
      if (!result.ok) setErrorKey(reminderErrorKey(result.error))
      return result.ok
    } catch {
      setErrorKey('error.generic')
      return false
    }
  }

  const [draft, setDraft] = useState<Draft | null>(null)
  const inFlight = useRef(false)
  // A reminder deleted or completed elsewhere while being edited drops its form and its draft.
  const liveDraft = draft && isDraftLive(draft.id, reminders) ? draft : null
  useEffect(() => {
    if (draft && !liveDraft) setDraft(null)
  }, [draft, liveDraft])
  const editor: Editor = {
    draft: liveDraft,
    start: (reminder) => setDraft(startDraft(reminder)),
    change: (id, patch) => setDraft((current) => (current?.id === id ? { ...current, ...patch } : current)),
    close: (id) => setDraft((current) => (current?.id === id ? null : current)),
    inFlight,
  }

  const groups = reminders ? groupReminders(reminders, now) : null
  const empty = groups !== null && Object.values(groups).every((g) => g.length === 0)

  return (
    <div className="flex flex-col gap-5">
      <NoticeBanner />
      <ReminderComposer />
      {errorKey && (
        <p role="alert" className="text-small text-fail">
          {t(errorKey)}
        </p>
      )}
      {groups && (
        <div className="flex flex-col gap-5">
          <Group title="cc.reminders.group.overdue" items={groups.overdue} now={now} run={run} isBusy={isBusy} editor={editor} />
          <Group title="cc.reminders.group.upcoming" items={groups.upcoming} now={now} run={run} isBusy={isBusy} editor={editor} />
          <Group title="cc.reminders.group.repeating" items={groups.repeating} now={now} run={run} isBusy={isBusy} editor={editor} />
          <Group title="cc.reminders.group.completed" items={groups.completed} now={now} run={run} isBusy={isBusy} editor={editor} />
          {empty && (
            <p data-testid="reminders-empty" className="text-small text-graphite">
              {t('cc.reminders.empty')}
            </p>
          )}
        </div>
      )}
      <div>
        <SettingRow label={t('cc.reminders.snooze')} hint={t('cc.reminders.snoozeHint')}>
          <Segmented
            label={t('cc.reminders.snooze')}
            value={String(settings.reminders.snoozeMinutes)}
            options={SNOOZE_MINUTES_OPTIONS.map((minutes) => ({
              value: String(minutes),
              label: t('cc.reminders.snoozeOption', { minutes }),
            }))}
            onChange={(value) => {
              const snoozeMinutes = SNOOZE_MINUTES_OPTIONS.find((m) => String(m) === value)
              if (snoozeMinutes) patchReminders({ snoozeMinutes })
            }}
          />
        </SettingRow>
        <SettingRow label={t('cc.reminders.sound')} hint={t('cc.reminders.soundHint')}>
          <Switch
            label={t('cc.reminders.sound')}
            checked={settings.reminders.sound}
            onChange={(sound) => patchReminders({ sound })}
          />
        </SettingRow>
      </div>
    </div>
  )
}
