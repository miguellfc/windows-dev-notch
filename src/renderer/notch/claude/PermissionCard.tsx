import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { canAllow, hiddenPreviewChars, permissionButtons } from '../../../shared/claude/view'
import { useClaude } from '../../shared/claude-store'
import { useT } from '../../shared/use-t'

const SETTLE_MS = 600

type Decision = 'allow' | 'deny'

// Deciding is pointer-only: no key may activate these buttons (Enter/Space would be a one-keystroke approval).
const blockKey = (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') event.preventDefault()
}

/** The panel card for the oldest pending Claude permission request. */
export function PermissionCard() {
  const t = useT()
  const pending = useClaude((store) => store.state?.pending)
  // Request whose decision was sent and is still in pending: never decide it twice.
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)
  // A newly shown request stays disabled until its own settle timer fires, so a click aimed
  // at the previous one cannot land on it (derived from the id: no enabled frame in between).
  const [settledId, setSettledId] = useState<string | null>(null)
  const pointerDownId = useRef<string | null>(null)
  const request = pending?.[0]
  const shownId = request?.id

  useEffect(() => {
    if (shownId === undefined) return
    const timer = setTimeout(() => setSettledId(shownId), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [shownId])

  if (!pending || !request) return null
  const enabled = permissionButtons(request, { settledId, submittedId })
  const allowable = canAllow(request)
  const hidden = hiddenPreviewChars(request)
  const failed = failedId === request.id

  const decide = (decision: Decision, isEnabled: boolean) => (event: MouseEvent) => {
    const pressedId = pointerDownId.current
    pointerDownId.current = null
    // Keyboard-synthesised clicks carry detail 0; the click must also belong to the request the pointer went down on.
    if (event.detail === 0 || !isEnabled || pressedId !== request.id) return
    const id = request.id
    const fail = () => {
      setSubmittedId((current) => (current === id ? null : current))
      setFailedId(id)
    }
    setSubmittedId(id)
    setFailedId(null)
    window.notch.claude
      .decide({ requestId: id, decision })
      .then((result) => {
        if (!result.ok) fail()
      })
      .catch(fail)
  }
  const onPointerDown = () => {
    pointerDownId.current = request.id
  }
  const button =
    'h-9 flex-1 cursor-pointer rounded-control px-4 text-body font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50'

  return (
    <div data-testid="claude-permission" className="flex h-full flex-col px-5 pb-4 pt-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label font-medium text-wait">{t('claude.permission.title')}</p>
          <p className="mt-1 truncate text-title font-medium text-chalk">{request.sessionName}</p>
        </div>
        <span className="tabular shrink-0 pt-0.5 text-label text-graphite">
          {t('claude.permission.counter', { index: 1, total: pending.length })}
        </span>
      </header>
      <p className="mt-2 truncate font-mono text-small text-graphite">{request.toolName}</p>
      <div
        tabIndex={0}
        role="region"
        aria-label={t('claude.permission.preview')}
        data-testid="claude-permission-preview"
        className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-tile border border-line bg-veil px-3 py-2 font-mono text-small text-chalk"
      >
        {request.preview || <span className="text-graphite">{t('claude.permission.noPreview')}</span>}
        {request.previewTruncated && (
          <span data-testid="claude-permission-truncated" className="mt-2 block font-sans text-label text-wait">
            {t('claude.permission.truncated', { count: hidden })}
          </span>
        )}
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-label text-fail">
          {t('claude.permission.error')}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-testid="claude-deny"
          disabled={!enabled.deny}
          onKeyDown={blockKey}
          onKeyUp={blockKey}
          onPointerDown={onPointerDown}
          onClick={decide('deny', enabled.deny)}
          className={`${button} border border-line bg-veil-tile text-chalk hover:bg-veil-hover`}
        >
          {t('claude.permission.deny')}
        </button>
        <button
          type="button"
          data-testid="claude-allow"
          disabled={!enabled.allow}
          aria-description={allowable ? undefined : t('claude.permission.allowDisabled')}
          title={allowable ? undefined : t('claude.permission.allowDisabled')}
          onKeyDown={blockKey}
          onKeyUp={blockKey}
          onPointerDown={onPointerDown}
          onClick={decide('allow', enabled.allow)}
          className={`${button} bg-ice text-abyss hover:brightness-110`}
        >
          {t('claude.permission.allow')}
        </button>
      </div>
    </div>
  )
}
