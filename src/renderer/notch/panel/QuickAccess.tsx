import { SquareTerminal, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { AppTileId } from '../../../shared/integrations/registry'
import { ClaudeMark } from '../../shared/brand-icons'
import { useClaude } from '../../shared/claude-store'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { useQuestions } from '../../shared/questions-store'
import { useSettings } from '../../shared/settings-store'
import { useT } from '../../shared/use-t'

const FAILURE_VISIBLE_MS = 4_000

/** The app that just failed to open (its label), for as long as the help line says so. */
export function useOpenFailure(): { failed: MessageKey | null; reportFailure: (labelKey: MessageKey) => void } {
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const reportFailure = useCallback((labelKey: MessageKey) => {
    clearTimeout(timer.current)
    setFailed(labelKey)
    timer.current = setTimeout(() => setFailed(null), FAILURE_VISIBLE_MS)
  }, [])
  return { failed, reportFailure }
}

function QuickButton({
  app,
  labelKey,
  icon: Icon,
  style,
  iconClassName,
  description,
  onFailure,
  children,
}: {
  app: AppTileId
  labelKey: MessageKey
  icon: LucideIcon
  style?: CSSProperties
  iconClassName?: string
  description?: string | undefined
  onFailure: (labelKey: MessageKey) => void
  children?: ReactNode
}) {
  const t = useT()
  const open = async () => {
    const result = await window.notch.apps.open({ app })
    if (!result.ok || !result.data.ok) onFailure(labelKey)
  }
  return (
    <button
      type="button"
      data-testid={`integration-${app}`}
      aria-label={t(labelKey)}
      aria-description={description}
      title={t(labelKey)}
      style={style}
      onClick={() => void open()}
      className="relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[14px] border border-line bg-veil text-chalk transition-colors duration-150 hover:bg-veil-hover focus-visible:bg-veil-hover"
    >
      <Icon size={18} strokeWidth={1.8} aria-hidden="true" className={iconClassName} />
      {children}
    </button>
  )
}

/** The apps that open outside the notch: Claude while it is on, then Terminal, always. */
export function QuickAccess({ onFailure }: { onFailure: (labelKey: MessageKey) => void }) {
  const t = useT()
  const claudeOn = useSettings((state) => state.settings?.integrations.claude.enabled ?? false)
  const { color } = useIntegration('claude')
  const permissions = useClaude((store) => store.state?.pending.length ?? 0)
  const questions = useQuestions((store) => store.questions?.length ?? 0)
  const waiting = permissions + questions > 0
  return (
    <nav aria-label={t('panel.quickAccess')} className="flex w-11 shrink-0 flex-col gap-2.5">
      {claudeOn && (
        <QuickButton
          app="claude"
          labelKey="integration.claude"
          icon={ClaudeMark}
          style={integrationStyle(color)}
          iconClassName="text-[color:var(--int)]"
          description={waiting ? t('claude.status.waiting') : undefined}
          onFailure={onFailure}
        >
          {waiting && <span data-testid="quick-claude-pending" aria-hidden="true" className="absolute right-1 top-1 size-2.5 rounded-full bg-wait" />}
        </QuickButton>
      )}
      <QuickButton app="terminal" labelKey="integration.terminal" icon={SquareTerminal} onFailure={onFailure} />
    </nav>
  )
}
