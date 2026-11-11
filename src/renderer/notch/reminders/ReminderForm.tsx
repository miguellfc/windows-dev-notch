import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import { hasVisibleText, REMINDER_TEXT_MAX, type Reminder } from '../../../shared/reminders/schema'
import { buildDueAt, nextQuarterHour, todayIsoDate, tomorrowIsoDate, type FormDay } from '../../shared/reminders/form'
import { reminderErrorKey } from '../../shared/reminders/format'
import { useT } from '../../shared/use-t'
import { Segmented } from '../../ui/Segmented'
import { headerIconButton } from './styles'

type RepeatValue = Reminder['repeat']

const DAY_OPTIONS: readonly { value: FormDay; label: MessageKey }[] = [
  { value: 'today', label: 'reminders.form.dayToday' },
  { value: 'tomorrow', label: 'reminders.form.dayTomorrow' },
  { value: 'other', label: 'reminders.form.dayOther' },
]

const REPEAT_OPTIONS: readonly { value: RepeatValue; label: MessageKey }[] = [
  { value: 'none', label: 'reminders.repeat.none' },
  { value: 'daily', label: 'reminders.repeat.optionDaily' },
  { value: 'weekdays', label: 'reminders.repeat.optionWeekdays' },
]

const fieldClass =
  'h-[34px] rounded-control border border-line bg-veil px-2.5 text-body text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-ice/60 aria-invalid:border-fail/60'
const secondaryButton =
  'h-7 cursor-pointer rounded-control border border-line bg-veil-tile px-3 text-label font-medium text-chalk transition-colors duration-150 hover:bg-[rgba(255,255,255,0.09)] disabled:cursor-default disabled:opacity-40'
const primaryButton =
  'h-7 cursor-pointer rounded-control bg-ice px-3 text-label font-medium text-abyss transition-opacity duration-150 hover:opacity-90 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:opacity-40'

interface Errors {
  text?: MessageKey | undefined
  date?: MessageKey | undefined
  time?: MessageKey | undefined
  form?: MessageKey | undefined
}

/** Where a server error belongs: next to the field it is about, else above the actions. */
function serverErrors(key: MessageKey): Errors {
  if (key === 'reminders.error.past') return { time: key }
  if (key === 'reminders.error.emptyText' || key === 'reminders.error.tooLong') return { text: key }
  return { form: key }
}

/** One labelled row: label column on the left, control and its inline error on the right. */
function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="flex h-[34px] items-center text-label font-medium text-graphite">
          {label}
        </label>
      ) : (
        <span className="flex h-[34px] items-center text-label font-medium text-graphite">{label}</span>
      )}
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

/**
 * The notch's new-reminder form: text, day, 24 h time and repeat. Validates locally first
 * (inline, next to each field), then creates `{ text, dueAt, repeat }` in main.
 */
export function ReminderForm({ onDone }: { onDone: () => void }) {
  const t = useT()
  const textInput = useRef<HTMLInputElement>(null)
  const [initial] = useState(() => {
    const now = new Date()
    return { ...nextQuarterHour(now), today: todayIsoDate(now), tomorrow: tomorrowIsoDate(now) }
  })
  const [text, setText] = useState('')
  const [day, setDay] = useState<FormDay>(initial.day)
  // "Other day" starts on tomorrow (today and tomorrow have their own choices); min stays today.
  const [date, setDate] = useState(initial.tomorrow)
  const [time, setTime] = useState(initial.time)
  const [repeat, setRepeat] = useState<RepeatValue>('none')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false) // blocks a second save in the same tick, before state re-renders

  useEffect(() => {
    textInput.current?.focus()
  }, [])

  const save = async () => {
    if (inFlight.current) return
    const trimmed = text.trim()
    const next: Errors = {}
    if (!hasVisibleText(trimmed)) next.text = 'reminders.form.errorText'
    else if (trimmed.length > REMINDER_TEXT_MAX) next.text = 'reminders.error.tooLong'
    const due = buildDueAt({ day, date, time, repeat }, new Date())
    if ('error' in due) {
      if (due.error === 'time') next.time = 'reminders.form.errorTime'
      else if (due.error === 'date') next.date = 'reminders.form.errorDate'
      else next.time = 'reminders.error.past'
    }
    setErrors(next)
    if (next.text || next.time || next.date || 'error' in due) return

    inFlight.current = true
    setBusy(true)
    try {
      const result = await window.notch.reminders.create({ text: trimmed, dueAt: due.dueAt.toISOString(), repeat })
      if (result.ok) {
        onDone()
        return
      }
      setErrors(serverErrors(reminderErrorKey(result.error)))
    } catch {
      setErrors({ form: 'error.generic' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void save()
  }

  // Esc anywhere in the form goes back to the list. Stopping here keeps the panel's Esc (back to
  // the integrations row) and NotchApp's window-level dismiss from also firing.
  const onFormKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onDone()
  }

  return (
    // Focusable (not tabbable) so a click on a blank area keeps focus in the form and Esc still
    // reaches onFormKeyDown instead of NotchApp's window-level dismiss.
    <div
      data-testid="reminder-form"
      tabIndex={-1}
      onKeyDown={onFormKeyDown}
      className="flex min-h-0 flex-1 flex-col gap-2 outline-none"
    >
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="reminder-form-back"
          onClick={onDone}
          aria-label={t('reminders.form.back')}
          title={t('reminders.form.back')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="ml-2 text-body font-medium text-chalk">{t('reminders.view.new')}</h2>
      </header>
      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
        <Row label={t('reminders.form.text')} htmlFor="reminder-form-text">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              ref={textInput}
              id="reminder-form-text"
              type="text"
              data-testid="reminder-form-text"
              value={text}
              maxLength={REMINDER_TEXT_MAX}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('reminders.form.textPlaceholder')}
              aria-invalid={errors.text !== undefined}
              aria-describedby={errors.text ? 'reminder-form-text-error' : undefined}
              onChange={(event) => {
                setText(event.target.value)
                setErrors((e) => ({ ...e, text: undefined, form: undefined }))
              }}
              onKeyDown={onFieldKeyDown}
              className={`${fieldClass} w-full`}
            />
            <FieldError id="reminder-form-text-error" messageKey={errors.text} />
          </div>
        </Row>

        {repeat === 'none' && (
          <Row label={t('reminders.form.day')}>
            <Segmented
              label={t('reminders.form.day')}
              value={day}
              options={DAY_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
              onChange={(value) => {
                setDay(value)
                setErrors((e) => ({ ...e, date: undefined, time: e.time === 'reminders.error.past' ? undefined : e.time }))
              }}
            />
          </Row>
        )}

        {repeat === 'none' && day === 'other' && (
          <Row label={t('reminders.form.date')} htmlFor="reminder-form-date">
            <input
              id="reminder-form-date"
              type="date"
              data-testid="reminder-form-date"
              value={date}
              min={initial.today}
              aria-invalid={errors.date !== undefined}
              aria-describedby={errors.date ? 'reminder-form-date-error' : undefined}
              onChange={(event) => {
                setDate(event.target.value)
                setErrors((e) => ({ ...e, date: undefined, time: e.time === 'reminders.error.past' ? undefined : e.time }))
              }}
              onKeyDown={onFieldKeyDown}
              className={`${fieldClass} tabular w-[136px] shrink-0 [color-scheme:dark]`}
            />
            <FieldError id="reminder-form-date-error" messageKey={errors.date} />
          </Row>
        )}

        <Row label={t('reminders.form.time')} htmlFor="reminder-form-time">
          <input
            id="reminder-form-time"
            type="text"
            inputMode="numeric"
            data-testid="reminder-form-time"
            value={time}
            maxLength={5}
            spellCheck={false}
            autoComplete="off"
            placeholder="HH:mm"
            aria-invalid={errors.time !== undefined}
            aria-describedby={errors.time ? 'reminder-form-time-error' : undefined}
            onChange={(event) => {
              setTime(event.target.value)
              setErrors((e) => ({ ...e, time: undefined }))
            }}
            onKeyDown={onFieldKeyDown}
            className={`${fieldClass} tabular w-[72px] shrink-0 text-center`}
          />
          <FieldError id="reminder-form-time-error" messageKey={errors.time} />
        </Row>

        <Row label={t('reminders.form.repeat')}>
          <Segmented
            label={t('reminders.form.repeat')}
            value={repeat}
            options={REPEAT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
            onChange={(value) => {
              setRepeat(value)
              setErrors((e) => ({ ...e, date: undefined, time: e.time === 'reminders.error.past' ? undefined : e.time }))
            }}
          />
        </Row>
      </div>

      <div className="mt-auto flex items-center justify-end gap-2">
        {errors.form && (
          <p role="alert" data-testid="reminder-form-error" className="mr-auto min-w-0 truncate text-label text-fail">
            {t(errors.form)}
          </p>
        )}
        <button type="button" data-testid="reminder-form-cancel" onClick={onDone} className={secondaryButton}>
          {t('reminders.form.cancel')}
        </button>
        <button
          type="button"
          data-testid="reminder-form-save"
          // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would
          // dismiss the notch. save() is already a no-op while a call is in flight.
          aria-disabled={busy}
          onClick={() => void save()}
          className={primaryButton}
        >
          {t('reminders.form.save')}
        </button>
      </div>
    </div>
  )
}
