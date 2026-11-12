import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { Settings } from '../../shared/settings/schema'
import { useGmail } from '../shared/gmail-store'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'

const GUIDE_PATH = 'docs/gmail-setup.md'

const input =
  'h-8 w-full min-w-0 rounded-control border border-line bg-veil px-2.5 font-mono text-body text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-ice/60'
const button =
  'flex h-8 shrink-0 cursor-pointer items-center rounded-control border border-line bg-veil-tile px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-veil-tile'
const primary =
  'flex h-8 shrink-0 cursor-pointer items-center rounded-control border border-ice/40 bg-ice/25 px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-ice/35 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ice/25'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-caps font-medium uppercase text-graphite">{title}</h2>
      {children}
    </section>
  )
}

function Notice({ tone, children, testId }: { tone: 'warn' | 'fail' | 'info'; children: ReactNode; testId: string }) {
  const color = tone === 'fail' ? 'border-fail/40 text-fail' : tone === 'warn' ? 'border-wait/40 text-wait' : 'border-line text-graphite'
  return (
    <p role="status" data-testid={testId} className={`mt-3 rounded-control border bg-veil px-3 py-2 text-small ${color}`}>
      {children}
    </p>
  )
}

type ClientNotice = 'saved' | 'saveError' | 'fileInvalid' | 'fileError'

/**
 * Gmail setup: the Google client (saved explicitly, so a half-typed ID never signs the user out)
 * and the session. The secret is a password field with a show toggle; it never reaches the log.
 */
export function GmailPage({ settings }: { settings: Settings }) {
  const t = useT()
  const state = useGmail((store) => store.state)
  const idField = useId()
  const secretField = useId()
  const saved = settings.gmail
  const [clientId, setClientId] = useState(saved.clientId)
  const [clientSecret, setClientSecret] = useState(saved.clientSecret)
  const [revealed, setRevealed] = useState(false)
  const [notice, setNotice] = useState<ClientNotice | null>(null)
  const [signInFailed, setSignInFailed] = useState(false)

  // What was saved (from here or another window) replaces the drafts.
  useEffect(() => {
    setClientId(saved.clientId)
    setClientSecret(saved.clientSecret)
  }, [saved.clientId, saved.clientSecret])

  const draft = { clientId: clientId.trim(), clientSecret: clientSecret.trim() }
  const dirty = draft.clientId !== saved.clientId || draft.clientSecret !== saved.clientSecret
  const complete = draft.clientId !== '' && draft.clientSecret !== ''

  const save = async (next: { clientId: string; clientSecret: string }) => {
    const result = await useSettings.getState().update({ gmail: next })
    setNotice(result.ok ? 'saved' : 'saveError')
  }

  const loadFile = async () => {
    setNotice(null)
    const result = await window.notch.gmail.pickClientFile()
    if (!result.ok) return setNotice(result.error.code === 'INVALID_INPUT' ? 'fileInvalid' : 'fileError')
    if (result.data === null) return
    setClientId(result.data.clientId)
    setClientSecret(result.data.clientSecret)
    await save(result.data)
  }

  const signIn = async () => {
    setSignInFailed(false)
    const result = await window.notch.gmail.signIn()
    if (!result.ok || result.data === 'error') setSignInFailed(true)
  }

  const status = state?.status
  const signedIn = status === 'ok' || status === 'offline'
  const message = notice === null ? null : t(`cc.gmail.${notice}`)

  const edit = (setter: (value: string) => void) => (event: { target: { value: string } }) => {
    setter(event.target.value)
    setNotice(null)
  }

  return (
    <div data-testid="gmail-page">
      <Group title={t('cc.gmail.clientTitle')}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={idField} className="text-small text-graphite">
              {t('cc.gmail.clientId')}
            </label>
            <input id={idField} type="text" autoComplete="off" spellCheck={false} maxLength={256} value={clientId} onChange={edit(setClientId)} className={input} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={secretField} className="text-small text-graphite">
              {t('cc.gmail.clientSecret')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id={secretField}
                type={revealed ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                value={clientSecret}
                onChange={edit(setClientSecret)}
                className={input}
              />
              <button
                type="button"
                aria-label={t('cc.gmail.showSecret')}
                aria-pressed={revealed}
                onClick={() => setRevealed((value) => !value)}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk"
              >
                {revealed ? <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.8} aria-hidden="true" />}
              </button>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={() => void save(draft)} disabled={!dirty || !complete} className={primary}>
            {t('cc.gmail.save')}
          </button>
          <button type="button" onClick={() => void loadFile()} className={button}>
            {t('cc.gmail.loadFile')}
          </button>
          {message && (
            <span
              role={notice === 'saved' ? 'status' : 'alert'}
              data-testid="gmail-client-message"
              className={`min-w-0 text-small ${notice === 'saved' ? 'text-graphite' : 'text-fail'}`}
            >
              {message}
            </span>
          )}
        </div>
        <p className="mt-2 text-small text-graphite">{t('cc.gmail.resetNote')}</p>
      </Group>

      <Group title={t('cc.gmail.sessionTitle')}>
        <div className="flex items-center justify-between gap-4" data-testid="gmail-session" data-status={status}>
          <div className="min-w-0 text-body text-chalk">
            {signedIn ? (
              <span className="block truncate">{state?.account ? t('cc.gmail.connectedAs', { account: state.account }) : t('cc.gmail.connected')}</span>
            ) : (
              <span className="text-graphite">{status === 'signing-in' ? t('cc.gmail.waiting') : t('cc.gmail.signedOut')}</span>
            )}
          </div>
          {status === 'signing-in' ? (
            <button type="button" onClick={() => void window.notch.gmail.cancelSignIn()} className={button}>
              {t('cc.gmail.cancel')}
            </button>
          ) : signedIn ? (
            <button type="button" onClick={() => void window.notch.gmail.signOut()} className={button}>
              {t('cc.gmail.signOut')}
            </button>
          ) : (
            <button type="button" onClick={() => void signIn()} disabled={status === undefined || status === 'unconfigured'} className={primary}>
              {t('cc.gmail.signIn')}
            </button>
          )}
        </div>
        {status === 'unconfigured' && <p className="mt-2 text-small text-graphite">{t('cc.gmail.signInNeedsClient')}</p>}
        {status === 'offline' && (
          <Notice tone="info" testId="gmail-offline">
            {t('cc.gmail.offline')}
          </Notice>
        )}
        {status === 'expired' && (
          <Notice tone="warn" testId="gmail-expired">
            {t('cc.gmail.expired')}
          </Notice>
        )}
        {signInFailed && status !== 'signing-in' && (
          <Notice tone="fail" testId="gmail-sign-in-failed">
            {t('cc.gmail.signInFailed')}
          </Notice>
        )}
        {state?.persistent === false && (
          <Notice tone="warn" testId="gmail-not-persistent">
            {t('cc.gmail.notPersistent')}
          </Notice>
        )}
      </Group>

      <Group title={t('cc.gmail.stepsTitle')}>
        <ol className="list-decimal space-y-1.5 pl-5 text-small text-graphite">
          <li>{t('cc.gmail.step1')}</li>
          <li>{t('cc.gmail.step2')}</li>
          <li>{t('cc.gmail.step3')}</li>
          <li>{t('cc.gmail.step4')}</li>
        </ol>
        <p className="mt-3 text-small text-graphite">{t('cc.gmail.guide', { path: GUIDE_PATH })}</p>
      </Group>
    </div>
  )
}
