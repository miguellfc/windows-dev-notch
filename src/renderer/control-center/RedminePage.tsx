import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import { REDMINE_KEY_MAX } from '../../shared/redmine/schema'
import { REDMINE_URL_MAX } from '../../shared/redmine/url'
import type { Language, Settings } from '../../shared/settings/schema'
import { locale } from '../shared/locale'
import { useRedmine } from '../shared/redmine-store'
import { useSettings } from '../shared/settings-store'
import { useLanguage, useT } from '../shared/use-t'
import { Switch } from '../ui/Switch'
import { SettingRow } from './ControlCenterApp'
import { createLatestRequests } from './latest-request'
import { createRedmineUpdater } from './redmine-settings-patch'
import { parseTarget } from './redmine-target'

const GUIDE_PATH = 'docs/redmine-setup.md'
const STEPS: readonly MessageKey[] = ['cc.redmine.step1', 'cc.redmine.step2', 'cc.redmine.step3']

// Every redmine patch goes through one chain so quick changes never build on stale settings.
const updateRedmine = createRedmineUpdater(
  () => useSettings.getState().settings!.redmine,
  (patch) => useSettings.getState().update(patch),
)

// Only the newest "check and save" may show its answer.
const requests = createLatestRequests<'redmine'>()

const input =
  'h-8 w-full min-w-0 rounded-control border border-line bg-veil px-2.5 font-mono text-body text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-select/60'
const field =
  'h-8 rounded-control border border-line bg-veil px-2.5 text-body text-chalk outline-none transition-colors duration-150 focus:border-select/60 aria-invalid:border-fail/60 disabled:cursor-not-allowed disabled:opacity-40'
const button =
  'flex h-8 shrink-0 cursor-pointer items-center rounded-control border border-line bg-veil-tile px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-veil-tile'
const primary =
  'flex h-8 shrink-0 cursor-pointer items-center rounded-control border border-select/40 bg-select/25 px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-select/35 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-select/25'

type SaveError = 'auth' | 'network' | 'url' | 'save'
const ERRORS: Record<SaveError, MessageKey> = {
  auth: 'cc.redmine.errAuth',
  network: 'cc.redmine.errNetwork',
  url: 'cc.redmine.errUrl',
  save: 'cc.redmine.errSave',
}

function Card({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="mb-6 rounded-card border border-line p-4">
      <h2 className="mb-3 text-body font-medium text-chalk">{title}</h2>
      {children}
    </section>
  )
}

const formatHours = (hours: number, language: Language): string => new Intl.NumberFormat(locale(language), { maximumFractionDigits: 1 }).format(hours)

/** The daily target: a text field that commits on blur or Enter; an invalid draft stays put with its hint. */
function TargetField({ value }: { value: number }) {
  const t = useT()
  const language = useLanguage()
  const errorId = useId()
  const [draft, setDraft] = useState(formatHours(value, language))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setDraft(formatHours(value, language))
    setInvalid(false)
  }, [value, language])

  const commit = () => {
    const parsed = parseTarget(draft)
    if (parsed === null) return setInvalid(true)
    setInvalid(false)
    setDraft(formatHours(parsed, language))
    if (parsed !== value) void updateRedmine((latest) => ({ ...latest, dailyTargetHours: parsed }))
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          data-testid="redmine-target"
          aria-label={t('cc.redmine.target')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          className={`${field} tabular w-20 text-right`}
        />
        <span aria-hidden="true" className="text-small text-graphite">
          {t('cc.redmine.targetUnit')}
        </span>
      </div>
      {invalid && (
        <span id={errorId} role="alert" className="text-small text-fail">
          {t('cc.redmine.targetRange')}
        </span>
      )}
    </div>
  )
}

/** The end-of-day time: a time input that only commits a complete, valid `HH:mm`. */
function TimeField({ value, disabled }: { value: string; disabled: boolean }) {
  const t = useT()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <input
      type="time"
      data-testid="redmine-end-of-day-time"
      aria-label={t('cc.redmine.endOfDayTime')}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(next) && next !== value) void updateRedmine((latest) => ({ ...latest, endOfDay: { ...latest.endOfDay, time: next } }))
      }}
      onBlur={() => setDraft(value)}
      className={`${field} tabular [color-scheme:dark]`}
    />
  )
}

/** Redmine: server and API key (the key only lives in the input's value), status, the daily target and the end-of-day alert. */
export function RedminePage({ settings }: { settings: Settings }) {
  const t = useT()
  const urlField = useId()
  const keyField = useId()
  const errorId = useId()
  const state = useRedmine((store) => store.state)
  const savedUrl = settings.redmine.url
  const { endOfDay } = settings.redmine
  const [key, setKey] = useState('')
  const [url, setUrl] = useState(savedUrl)
  const [revealed, setRevealed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<SaveError | null>(null)
  const status = state?.status
  const configured = status !== undefined && status !== 'unconfigured'

  // What was saved (from here or another window) replaces the draft URL.
  useEffect(() => setUrl(savedUrl), [savedUrl])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = key.trim()
    if (value === '') return
    const seq = requests.begin('redmine')
    setChecking(true)
    setError(null)
    const result = await window.notch.redmine.setKey({ url: url.trim(), key: value })
    // A newer request owns the screen now; this answer (often a false "network") is stale.
    if (!requests.isCurrent('redmine', seq)) return
    setChecking(false)
    if (!result.ok) return setError('save')
    if (!result.data.ok) return setError(result.data.reason)
    setKey('')
    setRevealed(false)
  }

  const remove = async () => {
    requests.begin('redmine') // an answer still on its way no longer applies
    setChecking(false)
    setError(null)
    setKey('')
    const result = await window.notch.redmine.clear()
    if (!result.ok) setError('save')
  }

  const statusText =
    status === 'ok'
      ? state?.account
        ? t('cc.redmine.connectedAs', { account: state.account })
        : t('cc.redmine.connected')
      : status === 'offline'
        ? t('cc.redmine.offline')
        : status === 'auth-error'
          ? t('cc.redmine.authError')
          : t('cc.redmine.unconfigured')

  return (
    <div data-testid="redmine-page">
      <Card title={t('cc.redmine.connection')} testId="redmine-connection">
        <div className="mb-3 flex items-center justify-between gap-3" data-testid="redmine-status" data-status={status}>
          <span className={`min-w-0 truncate text-body ${status === 'ok' ? 'text-chalk' : status === 'auth-error' ? 'text-wait' : 'text-graphite'}`}>{statusText}</span>
          {configured && (
            <button type="button" onClick={() => void remove()} className={button}>
              {t('cc.redmine.remove')}
            </button>
          )}
        </div>

        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlField} className="text-small text-graphite">
              {t('cc.redmine.url')}
            </label>
            <input
              id={urlField}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={REDMINE_URL_MAX}
              aria-invalid={error === 'url'}
              aria-describedby={error === 'url' ? errorId : undefined}
              placeholder={t('cc.redmine.urlPlaceholder')}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setError(null)
              }}
              className={input}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={keyField} className="text-small text-graphite">
              {t('cc.redmine.key')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id={keyField}
                type={revealed ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                maxLength={REDMINE_KEY_MAX}
                aria-invalid={error === 'auth' || error === 'network'}
                aria-describedby={error === 'auth' || error === 'network' ? errorId : undefined}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value)
                  setError(null)
                }}
                className={input}
              />
              <button
                type="button"
                aria-label={t('cc.redmine.show')}
                aria-pressed={revealed}
                onClick={() => setRevealed((value) => !value)}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk"
              >
                {revealed ? <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.8} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={key.trim() === '' || checking} className={primary}>
              {checking ? t('cc.redmine.checking') : t('cc.redmine.check')}
            </button>
            {error && (
              <span id={errorId} role="alert" data-testid="redmine-error" className="min-w-0 text-small text-fail">
                {t(ERRORS[error])}
              </span>
            )}
          </div>
        </form>

        {configured && state?.persistent === false && (
          <p role="status" data-testid="redmine-not-persistent" className="mt-3 rounded-control border border-wait/40 bg-veil px-3 py-2 text-small text-wait">
            {t('cc.redmine.notPersistent')}
          </p>
        )}

        <h3 className="mb-2 mt-3 text-caps font-medium uppercase text-graphite">{t('cc.redmine.stepsTitle')}</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-small text-graphite">
          {STEPS.map((step) => (
            <li key={step}>{t(step)}</li>
          ))}
        </ol>
      </Card>

      <Card title={t('cc.redmine.workday')} testId="redmine-workday">
        <SettingRow label={t('cc.redmine.target')} hint={t('cc.redmine.targetHint')}>
          <TargetField value={settings.redmine.dailyTargetHours} />
        </SettingRow>
        <SettingRow label={t('cc.redmine.endOfDay')} hint={t('cc.redmine.endOfDayHint')}>
          <Switch
            label={t('cc.redmine.endOfDay')}
            checked={endOfDay.enabled}
            onChange={(enabled) => void updateRedmine((latest) => ({ ...latest, endOfDay: { ...latest.endOfDay, enabled } }))}
          />
        </SettingRow>
        <SettingRow label={t('cc.redmine.endOfDayTime')}>
          <TimeField value={endOfDay.time} disabled={!endOfDay.enabled} />
        </SettingRow>
        <SettingRow label={t('cc.redmine.endOfDaySound')}>
          <Switch
            label={t('cc.redmine.endOfDaySound')}
            checked={endOfDay.sound}
            disabled={!endOfDay.enabled}
            onChange={(sound) => void updateRedmine((latest) => ({ ...latest, endOfDay: { ...latest.endOfDay, sound } }))}
          />
        </SettingRow>
      </Card>

      <p className="text-small text-graphite">{t('cc.redmine.guide', { path: GUIDE_PATH })}</p>
    </div>
  )
}
