import { AlertTriangle, Check, CircleHelp, Clock, Minus, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import {
  connectionView,
  diffMarker,
  portInUse,
  rotateNotice,
  type DiffLine,
  type StatusIcon,
  type StatusTone,
  type StatusView,
} from '../../shared/claude/page-status'
import { useClaude } from '../shared/claude-store'
import { useT } from '../shared/use-t'
import { Switch } from '../ui/Switch'
import { SettingRow } from './ControlCenterApp'
import { IntegrationDisabledNotice } from './IntegrationDisabledNotice'
import { accountFolderLabel, accountInitial, type AccountRow } from './work-log-account'

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

type Step = { accountId: string; mode: 'install' | 'uninstall' } | null
type Notice = { tone: 'info' | 'error'; key: MessageKey; params?: Record<string, string> } | null

const buttonClass =
  'btn h-8'
const primaryClass =
  'btn btn-primary h-8'

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
      <div id="claude-diff-title" className="mb-2 text-small text-graphite">
        {t('cc.claude.diffTitle')}
      </div>
      {/* Focusable so the keyboard can scroll it; named by its title for screen readers. */}
      <pre
        tabIndex={0}
        role="region"
        aria-labelledby="claude-diff-title"
        className="max-h-64 overflow-auto rounded-tile border border-line bg-veil p-3 font-mono text-small leading-5"
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

const HOOK_LABEL: Record<AccountRow['hookStatus'], MessageKey> = {
  installed: 'cc.claude.account.hooks.installed',
  outdated: 'cc.claude.account.hooks.outdated',
  missing: 'cc.claude.account.hooks.missing',
}

const HOOK_TONE: Record<AccountRow['hookStatus'], string> = {
  installed: 'text-ok',
  outdated: 'text-wait',
  missing: 'text-graphite',
}

/** One account: avatar, e-mail (else folder), «organización · carpeta», hooks status and its link switch. */
function AccountItem({
  account,
  busy,
  onToggle,
  onUpdate,
}: {
  account: AccountRow
  busy: boolean
  onToggle: () => void
  onUpdate: () => void
}) {
  const t = useT()
  const folder = accountFolderLabel(account)
  const title = account.email ?? folder
  const subtitle = account.email ? [account.organization, folder].filter(Boolean).join(' · ') : account.organization
  return (
    <div data-testid={`claude-account-${account.id}`} className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-veil text-small font-semibold text-chalk"
      >
        {accountInitial(account)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-chalk">{title}</div>
        {subtitle ? <div className="truncate text-small text-graphite">{subtitle}</div> : null}
        <div className="flex items-center gap-2 text-small">
          <span data-testid={`claude-account-status-${account.id}`} data-status={account.hookStatus} className={HOOK_TONE[account.hookStatus]}>
            {t(HOOK_LABEL[account.hookStatus])}
          </span>
          {account.linked && account.hookStatus === 'outdated' ? (
            <button
              type="button"
              disabled={busy}
              onClick={onUpdate}
              className="cursor-pointer text-chalk underline decoration-line underline-offset-2 hover:decoration-chalk"
            >
              {t('cc.claude.install')}
            </button>
          ) : null}
        </div>
      </div>
      <Switch checked={account.linked} disabled={busy} label={t('cc.claude.account.link', { name: folder })} onChange={onToggle} />
    </div>
  )
}

/** «Otra carpeta…»: the project has no folder-picker plugin, so the path is pasted and added. */
function AddFolder({ busy, onAdd }: { busy: boolean; onAdd: (dir: string) => void }) {
  const t = useT()
  const [dir, setDir] = useState('')
  const submit = () => {
    const value = dir.trim()
    if (!value) return
    onAdd(value)
    setDir('')
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        aria-label={t('cc.claude.account.folder')}
        placeholder={`${t('cc.claude.account.other')} ${t('cc.claude.account.folderPlaceholder')}`}
        value={dir}
        onChange={(event) => setDir(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
        className="field h-8 min-w-0 flex-1 px-2.5 font-mono text-small text-chalk outline-none transition-colors duration-150 placeholder:text-graphite focus:border-select/60"
      />
      <button type="button" disabled={busy || dir.trim() === ''} onClick={submit} className={buttonClass}>
        {t('cc.claude.account.add')}
      </button>
    </div>
  )
}

export function ClaudePage() {
  const t = useT()
  const state = useClaude((s) => s.state)
  const [accounts, setAccounts] = useState<readonly AccountRow[] | null>(null)
  const [step, setStep] = useState<Step>(null)
  const [diff, setDiff] = useState<readonly DiffLine[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const loadAccounts = useCallback(async () => {
    const result = await window.notch.claude.accounts()
    if (result.ok) setAccounts(result.data.accounts)
  }, [])
  // Again when main reports the hooks changed (installed or removed outside this page).
  const hooksState = state?.hooks
  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts, hooksState])

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
    setStep(null)
    setDiff(null)
  }

  const start = (accountId: string, mode: 'install' | 'uninstall') =>
    run(async () => {
      setNotice(null)
      setDiff(null)
      setStep(null)
      const result = await window.notch.claude.hooksPreview({ accountId })
      if (!result.ok) return setNotice({ tone: 'error', key: 'error.generic' })
      if (!result.data.ok) return setNotice({ tone: 'error', key: 'cc.claude.invalidJson' })
      setDiff(result.data.diff)
      setStep({ accountId, mode })
    })

  const confirm = () =>
    step &&
    run(async () => {
      const { accountId, mode } = step
      const call = mode === 'install' ? window.notch.claude.hooksInstall : window.notch.claude.hooksUninstall
      const result = await call({ accountId })
      setStep(null)
      setDiff(null)
      if (!result.ok) return setNotice({ tone: 'error', key: 'error.generic' })
      if (!result.data.ok) return setNotice({ tone: 'error', key: 'cc.claude.invalidJson' })
      const { changed, backupFile, diff: applied } = result.data
      setDiff(changed ? applied : null)
      if (backupFile) setNotice({ tone: 'info', key: 'cc.claude.backup', params: { file: backupFile } })
      else setNotice({ tone: 'info', key: changed ? (mode === 'install' ? 'cc.claude.installed' : 'cc.claude.uninstalled') : 'cc.claude.unchanged' })
      await loadAccounts()
    })

  const addFolder = (dir: string) =>
    run(async () => {
      setNotice(null)
      const result = await window.notch.claude.accountAdd({ dir })
      if (!result.ok) return setNotice({ tone: 'error', key: result.error.code === 'NOT_FOUND' ? 'cc.claude.account.notFound' : 'error.generic' })
      setAccounts(result.data.accounts)
      setNotice({ tone: 'info', key: 'cc.claude.account.added' })
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
      await loadAccounts()
    })

  if (!state) return null

  return (
    <div>
      <IntegrationDisabledNotice integration="claude" />
      {portInUse(state) ? (
        <div
          role="alert"
          data-testid="claude-port-in-use"
          className="mb-2 flex items-start gap-3 rounded-tile border border-fail/40 bg-veil p-3"
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

      <section data-testid="claude-accounts" className="border-b border-line py-4">
        <h2 className="text-body font-medium text-chalk">{t('cc.claude.accounts.title')}</h2>
        <p className="mb-3 mt-1 text-small text-graphite">{t('cc.claude.accounts.hint')}</p>
        <div className="flex flex-col gap-4">
          {(accounts ?? []).map((account) => (
            <div key={account.id} className="flex flex-col gap-3">
              <AccountItem
                account={account}
                busy={busy}
                onToggle={() => void start(account.id, account.linked ? 'uninstall' : 'install')}
                onUpdate={() => void start(account.id, 'install')}
              />
              {step?.accountId === account.id ? (
                <div className="flex flex-col gap-3">
                  {diff ? <DiffView diff={diff} /> : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void confirm()}
                      className={step.mode === 'install' ? primaryClass : `${buttonClass} btn-danger`}
                    >
                      {t(step.mode === 'install' ? 'cc.claude.confirmInstall' : 'cc.claude.confirmUninstall')}
                    </button>
                    <button type="button" disabled={busy} onClick={cancel} className={buttonClass}>
                      {t('cc.claude.cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          <AddFolder busy={busy} onAdd={(dir) => void addFolder(dir)} />
        </div>
      </section>

      {diff && !step ? (
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
