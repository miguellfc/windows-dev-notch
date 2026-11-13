import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { CODE_REVIEW_TOKEN_MAX, GITLAB_URL_MAX, type Platform, type PlatformState } from '../../shared/code-review/schema'
import type { MessageKey } from '../../shared/i18n/messages'
import type { Settings } from '../../shared/settings/schema'
import { useCodeReview } from '../shared/code-review-store'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { Switch } from '../ui/Switch'
import { SettingRow } from './ControlCenterApp'
import { createCodeReviewUpdater } from './code-review-settings-patch'
import { createLatestRequests } from './latest-request'

const GUIDE_PATH = 'docs/code-review-setup.md'

// Every codeReview patch goes through one chain so quick toggles never build on stale settings.
const updateCodeReview = createCodeReviewUpdater(
  () => useSettings.getState().settings!.codeReview,
  (patch) => useSettings.getState().update(patch),
)

// Only the newest "check and save" of a platform may show its answer.
const requests = createLatestRequests<Platform>()

const input =
  'h-8 w-full min-w-0 rounded-control border border-line bg-veil px-2.5 font-mono text-body text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-ice/60'
const button =
  'flex h-8 shrink-0 cursor-pointer items-center rounded-control border border-line bg-veil-tile px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-veil-tile'
const primary =
  'flex h-8 shrink-0 cursor-pointer items-center rounded-control border border-ice/40 bg-ice/25 px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-ice/35 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ice/25'

type SaveError = 'auth' | 'network' | 'url' | 'save'

const NAMES: Record<Platform, string> = { github: 'GitHub', gitlab: 'GitLab' }
const STEPS: Record<Platform, readonly MessageKey[]> = {
  github: ['cc.codeReview.ghStep1', 'cc.codeReview.ghStep2', 'cc.codeReview.ghStep3', 'cc.codeReview.ghStep4'],
  gitlab: ['cc.codeReview.glStep1', 'cc.codeReview.glStep2', 'cc.codeReview.glStep3', 'cc.codeReview.glStep4'],
}
const ERRORS: Record<Platform, Record<SaveError, MessageKey>> = {
  github: { auth: 'cc.codeReview.errAuthGithub', network: 'cc.codeReview.errNetworkGithub', url: 'cc.codeReview.errUrl', save: 'cc.codeReview.errSave' },
  gitlab: { auth: 'cc.codeReview.errAuthGitlab', network: 'cc.codeReview.errNetworkGitlab', url: 'cc.codeReview.errUrl', save: 'cc.codeReview.errSave' },
}
const ALERT_LABEL: Record<Platform, MessageKey> = { github: 'cc.codeReview.alertsEnabledGithub', gitlab: 'cc.codeReview.alertsEnabledGitlab' }

function Card({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="mb-6 rounded-card border border-line p-4">
      <h2 className="mb-3 text-body font-medium text-chalk">{title}</h2>
      {children}
    </section>
  )
}

/** One platform: token (and server for GitLab), status, alerts and the short steps. The token only lives in the input's value. */
function PlatformCard({ platform, settings, state }: { platform: Platform; settings: Settings; state: PlatformState | undefined }) {
  const t = useT()
  const urlField = useId()
  const tokenField = useId()
  const errorId = useId()
  const [token, setToken] = useState('')
  const [url, setUrl] = useState(settings.codeReview.gitlabUrl)
  const [revealed, setRevealed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<SaveError | null>(null)
  const savedUrl = settings.codeReview.gitlabUrl
  const alerts = settings.codeReview.alerts[platform]
  const status = state?.status
  const configured = status !== undefined && status !== 'unconfigured'

  // What was saved (from here or another window) replaces the draft URL.
  useEffect(() => setUrl(savedUrl), [savedUrl])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    if (value === '') return
    const seq = requests.begin(platform)
    setChecking(true)
    setError(null)
    const result = await window.notch.codeReview.setToken({ platform, token: value, ...(platform === 'gitlab' ? { url: url.trim() } : {}) })
    // A newer request owns the screen now; this answer (often a false "network") is stale.
    if (!requests.isCurrent(platform, seq)) return
    setChecking(false)
    if (!result.ok) return setError('save')
    if (!result.data.ok) return setError(result.data.reason)
    setToken('')
    setRevealed(false)
  }

  const remove = async () => {
    requests.begin(platform) // an answer still on its way no longer applies
    setChecking(false)
    setError(null)
    setToken('')
    const result = await window.notch.codeReview.clear({ platform })
    if (!result.ok) setError('save')
  }

  const patchAlerts = (patch: Partial<Settings['codeReview']['alerts'][Platform]>) => {
    void updateCodeReview((latest) => ({ alerts: { ...latest.alerts, [platform]: { ...latest.alerts[platform], ...patch } } }))
  }

  const statusText =
    status === 'ok'
      ? state?.account
        ? t('cc.codeReview.connectedAs', { account: state.account })
        : t('cc.codeReview.connected')
      : status === 'offline'
        ? t('cc.codeReview.offline')
        : status === 'auth-error'
          ? t('cc.codeReview.authError')
          : t('cc.codeReview.unconfigured')

  return (
    <Card title={NAMES[platform]} testId={`code-review-${platform}`}>
      <div className="mb-3 flex items-center justify-between gap-3" data-testid={`code-review-${platform}-status`} data-status={status}>
        <span className={`min-w-0 truncate text-body ${status === 'ok' ? 'text-chalk' : status === 'auth-error' ? 'text-wait' : 'text-graphite'}`}>{statusText}</span>
        {configured && (
          <button type="button" onClick={() => void remove()} className={button}>
            {t('cc.codeReview.remove')}
          </button>
        )}
      </div>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        {platform === 'gitlab' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlField} className="text-small text-graphite">
              {t('cc.codeReview.url')}
            </label>
            <input
              id={urlField}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={GITLAB_URL_MAX}
              aria-invalid={error === 'url'}
              aria-describedby={error === 'url' ? errorId : undefined}
              placeholder={t('cc.codeReview.urlPlaceholder')}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setError(null)
              }}
              className={input}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={tokenField} className="text-small text-graphite">
            {t(platform === 'github' ? 'cc.codeReview.tokenGithub' : 'cc.codeReview.tokenGitlab')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={tokenField}
              type={revealed ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              maxLength={CODE_REVIEW_TOKEN_MAX}
              aria-invalid={error === 'auth' || error === 'network'}
              aria-describedby={error === 'auth' || error === 'network' ? errorId : undefined}
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setError(null)
              }}
              className={input}
            />
            <button
              type="button"
              aria-label={t('cc.codeReview.show')}
              aria-pressed={revealed}
              onClick={() => setRevealed((value) => !value)}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk"
            >
              {revealed ? <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.8} aria-hidden="true" />}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="submit" disabled={token.trim() === '' || checking} className={primary}>
            {checking ? t('cc.codeReview.checking') : t('cc.codeReview.check')}
          </button>
          {error && (
            <span id={errorId} role="alert" data-testid={`code-review-${platform}-error`} className="min-w-0 text-small text-fail">
              {t(ERRORS[platform][error])}
            </span>
          )}
        </div>
      </form>

      {configured && state?.persistent === false && (
        <p role="status" data-testid={`code-review-${platform}-not-persistent`} className="mt-3 rounded-control border border-wait/40 bg-veil px-3 py-2 text-small text-wait">
          {t('cc.codeReview.notPersistent')}
        </p>
      )}

      <div className="mt-3">
        <SettingRow label={t(ALERT_LABEL[platform])}>
          <Switch label={`${NAMES[platform]}: ${t(ALERT_LABEL[platform])}`} checked={alerts.enabled} onChange={(enabled) => patchAlerts({ enabled })} />
        </SettingRow>
        <SettingRow label={t('cc.codeReview.alertsSound')}>
          <Switch label={`${NAMES[platform]}: ${t('cc.codeReview.alertsSound')}`} checked={alerts.sound} disabled={!alerts.enabled} onChange={(sound) => patchAlerts({ sound })} />
        </SettingRow>
      </div>

      <h3 className="mb-2 mt-3 text-caps font-medium uppercase text-graphite">{t('cc.codeReview.stepsTitle')}</h3>
      <ol className="list-decimal space-y-1.5 pl-5 text-small text-graphite">
        {STEPS[platform].map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
    </Card>
  )
}

/** GitHub and GitLab: one card per platform (token, status, alerts, steps) and the guide's path. */
export function CodeReviewPage({ settings }: { settings: Settings }) {
  const t = useT()
  const state = useCodeReview((store) => store.state)
  return (
    <div data-testid="code-review-page">
      <PlatformCard platform="github" settings={settings} state={state?.github} />
      <PlatformCard platform="gitlab" settings={settings} state={state?.gitlab} />
      <p className="text-small text-graphite">{t('cc.codeReview.guide', { path: GUIDE_PATH })}</p>
    </div>
  )
}
