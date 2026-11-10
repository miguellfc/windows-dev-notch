import { Repeat } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { Result } from '../../../shared/ipc/result'
import { parseReminder } from '../../../shared/reminders/parse'
import { REMINDER_TEXT_MAX, type Reminder, type ReminderPreset } from '../../../shared/reminders/schema'
import { useClock } from '../use-clock'
import { useLanguage, useT } from '../use-t'
import { formatDue, parseErrorKey, reminderErrorKey } from './format'

const CHIPS: readonly { preset: ReminderPreset; labelKey: MessageKey }[] = [
  { preset: '15m', labelKey: 'reminders.chip.15m' },
  { preset: '1h', labelKey: 'reminders.chip.1h' },
  { preset: 'tomorrow-9', labelKey: 'reminders.chip.tomorrow9' },
]

/** Live reading of the field: "Revisar PR · hoy 16:30 ↻", or why it cannot be read, in grey. */
function Preview({ value }: { value: string }) {
  const t = useT()
  const language = useLanguage()
  useClock() // re-read every minute so "today" and relative times stay true while the view is open
  if (value.trim() === '') return <span>{t('reminders.preview.hint')}</span>
  const now = new Date()
  const parsed = parseReminder(value, now)
  if ('error' in parsed) return <span>{t(parseErrorKey(parsed.error))}</span>
  const repeatLabel =
    parsed.repeat === 'daily' ? t('reminders.repeat.daily') : parsed.repeat === 'weekdays' ? t('reminders.repeat.weekdays') : null
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate text-chalk">{parsed.text}</span>
      <span aria-hidden="true">·</span>
      <span className="tabular shrink-0">{formatDue(parsed.dueAt, now, language)}</span>
      {repeatLabel && <Repeat size={12} strokeWidth={1.8} role="img" aria-label={repeatLabel} className="shrink-0" />}
    </span>
  )
}

/** The field at the top of the reminders view: type a time and a text, Enter or a chip creates it. */
export function ReminderComposer({
  autoFocus = false,
  onEscapeWhenEmpty,
}: {
  /** Claim focus on mount (the notch view does: the tile that opened it unmounts). */
  autoFocus?: boolean
  /** Esc on an empty field; when set, Esc is fully handled here (the notch goes back to the row). */
  onEscapeWhenEmpty?: () => void
}) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false) // blocks a second submit in the same tick, before state re-renders
  const text = value.trim()

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  const submit = async (call: () => Promise<Result<Reminder>>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setErrorKey(null)
    try {
      const result = await call()
      if (result.ok) setValue('')
      else setErrorKey(reminderErrorKey(result.error))
    } catch {
      setErrorKey('error.generic')
    } finally {
      inFlight.current = false
      setBusy(false)
      input.current?.focus()
    }
  }

  const createWithPreset = (preset: ReminderPreset) => {
    if (text.length > REMINDER_TEXT_MAX) {
      setErrorKey('reminders.error.tooLong')
      return
    }
    void submit(() => window.notch.reminders.create({ text, preset }))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit(() => window.notch.reminders.create({ input: value }))
    } else if (event.key === 'Escape' && (value !== '' || onEscapeWhenEmpty)) {
      // In the notch, Esc never dismisses it: it first clears the field, then goes back to the row.
      event.preventDefault()
      event.stopPropagation()
      if (value !== '') {
        setValue('')
        setErrorKey(null)
      } else {
        onEscapeWhenEmpty?.()
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={input}
        type="text"
        data-testid="reminder-input"
        value={value}
        maxLength={400}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('reminders.input.label')}
        aria-describedby={errorKey ? 'reminder-error' : 'reminder-preview'}
        aria-invalid={errorKey !== null}
        placeholder={t('reminders.input.placeholder')}
        onChange={(event) => {
          setValue(event.target.value)
          setErrorKey(null)
        }}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-control border border-line bg-veil px-3 text-body text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-ice/60"
      />
      {/* One line under the field: the error from the last attempt, else the live reading. */}
      {errorKey ? (
        <p id="reminder-error" role="alert" data-testid="reminder-error" className="flex h-4 items-center truncate px-1 text-small text-fail">
          {t(errorKey)}
        </p>
      ) : (
        <div id="reminder-preview" data-testid="reminder-preview" className="flex h-4 min-w-0 items-center px-1 text-small text-graphite">
          <Preview value={value} />
        </div>
      )}
      <div role="group" aria-label={t('reminders.chips.label')} className="flex gap-1.5">
        {CHIPS.map(({ preset, labelKey }) => (
          <button
            key={preset}
            type="button"
            data-testid={`reminder-chip-${preset}`}
            disabled={text === '' || busy}
            onClick={() => createWithPreset(preset)}
            className="tabular h-7 cursor-pointer rounded-full border border-line bg-veil-tile px-3 text-label font-medium text-chalk transition-colors duration-150 hover:bg-[rgba(255,255,255,0.09)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-veil-tile"
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
