import { AlertTriangle, Check, CircleHelp, Clock, Minus, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import {
  connectionView,
  diffMarker,
  hooksView,
  portInUse,
  rotateNotice,
  type DiffLine,
  type StatusIcon,
  type StatusTone,
  type StatusView,
} from '../../shared/claude/page-status'
import { useClaude } from '../shared/claude-store'
import { useT } from '../shared/use-t'
import { SettingRow } from './ControlCenterApp'

const ICONS: Record<StatusIcon, LucideIcon> = {
  check: Check,
  clock: Clock,
  alert: AlertTriangle,
  minus: Minus,
  help: CircleHelp,
}

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'text-ok',
  wait: 'text-wait',
  fail: 'text-fail',
  neutral: 'text-graphite',
}

const DIFF_CLASS: Record<DiffLine['kind'], string> = {
  add: 'text-ok',
  remove: 'text-fail',
  same: 'text-graphite',
}

type Step = 'idle' | 'confirm-install' | 'confirm-uninstall'
type Notice = { tone: 'info' | 'error'; key: MessageKey; params?: Record<string, string> } | null

const buttonClass =
  'h-8 cursor-pointer rounded-control border border-line bg-veil px-3 text-small text-chalk transition-colors duration-150 hover:bg-veil-tile disabled:cursor-default disabled:opacity-50'
const primaryClass =
  'h-8 cursor-pointer rounded-control bg-ice px-3 text-small font-medium text-abyss transition-opacity duration-150 hover:opacity-90 disabled:cursor-default disabled:opacity-50'

function StatusValue({ view }: { view: StatusView }) {
  const t = useT()
  const Icon = ICONS[view.icon]
  return (
    <span className={`flex items-center gap-2 text-small ${TONE_CLASS[view.tone]}`}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {t(view.label)}
    </span>
  )
}

function DiffView({ diff }: { diff: readonly DiffLine[] }) {
  const t = useT()
  if (diff.length === 0 || diff.every((line) => line.kind === 'same')) {
    return <p className="text-small text-graphite">{t('cc.claude.diffEmpty')}</p>
  }
  return (
    <div>
      <div className="mb-2 text-small text-graphite">{t('cc.claude.diffTitle')}</div>
      <pre
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-control border border-line bg-veil p-3 font-mono text-[12.5px] leading-5"
      >
        {diff.map((line, index) => (
          <div key={index} className={`whitespace-pre ${DIFF_CLASS[line.kind]}`}>
            <span aria-hidden="true">{diffMarker(line.kind)} </span>
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

export function ClaudePage() {
  const t = useT()
  const state = useClaude((s) => s.state)
  const [step, setStep] = useState<Step>('idle')
  const [diff, setDiff] = useState<readonly DiffLine[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch {
      setNotice({ tone: 'error', key: 'error.generic' })
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    setStep('idle')
    setDiff(null)
  }

  const startInstall = () =>
    run(async () => {
      setNotice(null)
      const result = await window.notch.claude.hooksPreview()
      if (!result.ok) return setNotice({ tone: 'error', key: 'error.generic' })
      if (!result.data.ok) return setNotice({ tone: 'error', key: 'cc.claude.invalidJson' })
      setDiff(result.data.diff)
      setStep('confirm-install')
    })

  const write = (call: () => ReturnType<typeof window.notch.claude.hooksInstall>, done: MessageKey) =>
    run(async () => {
      const result = await call()
      cancel()
      if (!result.ok) return setNotice({ tone: 'error', key: 'error.generic' })
      if (!result.data.ok) return setNotice({ tone: 'error', key: 'cc.claude.invalidJson' })
      const { changed, backupFile, diff: applied } = result.data
      setDiff(changed ? applied : null)
      if (backupFile) setNotice({ tone: 'info', key: 'cc.claude.backup', params: { file: backupFile } })
      else setNotice({ tone: 'info', key: changed ? done : 'cc.claude.unchanged' })
    })

  const test = () =>
    run(async () => {
      setNotice(null)
      const result = await window.notch.claude.testConnection()
      if (!result.ok) return setNotice({ tone: 'error', key: 'error.generic' })
      setNotice(result.data.ok ? { tone: 'info', key: 'cc.claude.testOk' } : { tone: 'error', key: 'cc.claude.testFail' })
    })

  const rotate = (what: 'token' | 'port') =>
    run(async () => {
      setNotice(null)
      const result = await (what === 'token' ? window.notch.claude.rotateToken() : window.notch.claude.rotatePort())
      setNotice(result.ok ? rotateNotice(what, result.data) : { tone: 'error', key: 'error.generic' })
    })

  if (!state) return null

  return (
    <div>
      {portInUse(state) ? (
        <div
          role="alert"
          data-testid="claude-port-in-use"
          className="mb-2 flex items-start gap-3 rounded-control border border-fail/40 bg-veil p-3"
        >
          <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0 text-fail" />
          <div className="min-w-0 flex-1">
            <p className="text-small text-chalk">{t('cc.claude.portInUse')}</p>
            <button type="button" disabled={busy} onClick={() => void rotate('port')} className={`${primaryClass} mt-3`}>
              {t('cc.claude.changePort')}
            </button>
          </div>
        </div>
      ) : null}
      <SettingRow label={t('cc.claude.connection.title')}>
        <StatusValue view={connectionView(state.connection)} />
      </SettingRow>
      <SettingRow label={t('cc.claude.hooks.title')}>
        <StatusValue view={hooksView(state.hooks)} />
      </SettingRow>

      <div className="flex flex-wrap items-center gap-2 border-b border-line py-4">
        {step === 'confirm-install' ? (
          <>
            <button type="button" disabled={busy} onClick={() => void write(window.notch.claude.hooksInstall, 'cc.claude.installed')} className={primaryClass}>
              {t('cc.claude.confirmInstall')}
            </button>
            <button type="button" disabled={busy} onClick={cancel} className={buttonClass}>
              {t('cc.claude.cancel')}
            </button>
          </>
        ) : step === 'confirm-uninstall' ? (
          <>
            <button type="button" disabled={busy} onClick={() => void write(window.notch.claude.hooksUninstall, 'cc.claude.uninstalled')} className={primaryClass}>
              {t('cc.claude.confirmUninstall')}
            </button>
            <button type="button" disabled={busy} onClick={cancel} className={buttonClass}>
              {t('cc.claude.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void startInstall()} className={buttonClass}>
              {t('cc.claude.install')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setNotice(null)
                setDiff(null)
                setStep('confirm-uninstall')
              }}
              className={buttonClass}
            >
              {t('cc.claude.uninstall')}
            </button>
          </>
        )}
      </div>

      {diff ? (
        <div className="border-b border-line py-4">
          <DiffView diff={diff} />
        </div>
      ) : null}

      <SettingRow label={t('cc.claude.test')}>
        <button type="button" disabled={busy} onClick={() => void test()} className={buttonClass}>
          {t('cc.claude.test')}
        </button>
      </SettingRow>
      <SettingRow label={t('cc.claude.rotate')} hint={t('cc.claude.rotateHint')}>
        <button type="button" disabled={busy} onClick={() => void rotate('token')} className={buttonClass}>
          {t('cc.claude.rotate')}
        </button>
      </SettingRow>

      <p
        role="status"
        aria-live="polite"
        className={`mt-3 min-h-5 text-small ${notice?.tone === 'error' ? 'text-fail' : 'text-graphite'}`}
      >
        {busy ? t('cc.claude.busy') : notice ? t(notice.key, notice.params) : ''}
      </p>
    </div>
  )
}
