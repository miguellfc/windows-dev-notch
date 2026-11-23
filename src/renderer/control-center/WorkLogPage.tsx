import { useEffect, useId, useState } from 'react'
import type { Settings } from '../../shared/settings/schema'
import { useClaude } from '../shared/claude-store'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { SettingRow } from './ControlCenterApp'
import { IntegrationDisabledNotice } from './IntegrationDisabledNotice'
import { parseAlertField } from './system-alerts-form'
import { accountOptionLabel, IDLE_PAUSE_RANGE, linkedAccounts, needsAccountChoice, type AccountRow } from './work-log-account'

const control =
  'field h-8 px-2.5 text-body text-chalk outline-none transition-colors duration-150 focus:border-select/60 aria-invalid:border-fail/60'

/** The maximum pause: whole minutes, validated on blur or Enter; an invalid draft saves nothing. */
function IdleField({ value, onCommit }: { value: number; onCommit: (minutes: number) => void }) {
  const t = useT()
  const errorId = useId()
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setDraft(String(value))
    setInvalid(false)
  }, [value])
  const commit = () => {
    const parsed = parseAlertField(draft, IDLE_PAUSE_RANGE)
    if (!parsed.ok) return setInvalid(true)
    setInvalid(false)
    setDraft(String(parsed.value))
    if (parsed.value !== value) onCommit(parsed.value)
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label={t('cc.workLog.idle')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          data-testid="work-log-idle"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          className={`${control} tabular w-16 text-center`}
        />
        <span aria-hidden="true" className="text-small text-graphite">
          {t('cc.workLog.minutes')}
        </span>
      </div>
      {invalid ? (
        <span id={errorId} role="alert" className="text-small text-fail">
          {t('cc.workLog.range', { min: IDLE_PAUSE_RANGE.min, max: IDLE_PAUSE_RANGE.max })}
        </span>
      ) : null}
    </div>
  )
}

/** The measured account, among the linked ones; a notice while none is usable. */
function AccountPicker({ accounts, accountId }: { accounts: readonly AccountRow[]; accountId: string | null }) {
  const t = useT()
  const linked = linkedAccounts(accounts)
  const missing = needsAccountChoice(accounts, accountId)
  return (
    <div className="flex flex-col items-end gap-1">
      <select
        aria-label={t('cc.workLog.account')}
        data-testid="work-log-account"
        value={missing ? '' : (accountId ?? '')}
        onChange={(event) => void useSettings.getState().update({ workLog: { accountId: event.target.value || null } })}
        className={`${control} max-w-56`}
      >
        {missing ? (
          <option value="" disabled>
            {t('cc.workLog.chooseAccount')}
          </option>
        ) : null}
        {linked.map((account) => (
          <option key={account.id} value={account.id}>
            {accountOptionLabel(account)}
          </option>
        ))}
      </select>
      {missing ? (
        <span data-testid="work-log-choose-account" role="status" className="text-small text-wait">
          {t('cc.workLog.chooseAccount')}
        </span>
      ) : null}
    </div>
  )
}

export function WorkLogPage({ settings }: { settings: Settings }) {
  const t = useT()
  const hooks = useClaude((s) => s.state?.hooks)
  const [accounts, setAccounts] = useState<readonly AccountRow[]>([])
  const [claudeFound, setClaudeFound] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void window.notch.claude.accounts().then((result) => {
      if (live && result.ok) setAccounts(result.data.accounts)
    })
    return () => {
      live = false
    }
  }, [hooks])

  useEffect(() => {
    let live = true
    void window.notch.workLog.claudeAvailable().then((result) => {
      if (live) setClaudeFound(result.ok ? result.data.found : false)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <div>
      <IntegrationDisabledNotice integration="workLog" />
      <SettingRow label={t('cc.workLog.account')} hint={t('cc.workLog.accountHint')}>
        <AccountPicker accounts={accounts} accountId={settings.workLog.accountId} />
      </SettingRow>
      <SettingRow label={t('cc.workLog.idle')} hint={t('cc.workLog.idleHint')}>
        <IdleField
          value={settings.workLog.idlePauseMinutes}
          onCommit={(minutes) => void useSettings.getState().update({ workLog: { idlePauseMinutes: minutes } })}
        />
      </SettingRow>
      <SettingRow label={t('cc.workLog.summary')} hint={t('cc.workLog.summaryHint')}>
        <span
          data-testid="work-log-claude-available"
          data-found={claudeFound === null ? undefined : String(claudeFound)}
          className={`text-small ${claudeFound === false ? 'text-fail' : claudeFound ? 'text-ok' : 'text-graphite'}`}
        >
          {claudeFound === null ? t('cc.workLog.claudeChecking') : claudeFound ? t('cc.workLog.claudeFound') : t('cc.workLog.claudeMissing')}
        </span>
      </SettingRow>
    </div>
  )
}
