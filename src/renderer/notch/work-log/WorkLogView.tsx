import { ArrowLeft, ClipboardList } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { WORK_LOG_SIZE } from '../../../shared/notch/geometry'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { useClock } from '../../shared/use-clock'
import { useT } from '../../shared/use-t'
import { setWorkLogViewHeight, useWorkLog } from '../../shared/work-log-store'
import { UNDO_MS } from '../notes/UndoBar'
import { headerIconButton } from '../reminders/styles'
import { WorkLogDetail } from './WorkLogDetail'
import { entryRow, entryRows, WorkLogList } from './WorkLogList'

const undoButton = 'btn h-6 shrink-0 focus-inset aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:[filter:none]'

/** "Entrada borrada · Deshacer" for 5 s after a delete, like the notes' bar; main keeps the entry restorable for 10 s. */
function UndoDelete({ sessionId, expiresAt, onDone }: { sessionId: string; expiresAt: number; onDone: () => void }) {
  const t = useT()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  }, [onDone])

  useEffect(() => {
    const timer = setTimeout(() => done.current(), Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])

  const undo = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.notch.workLog.restore({ sessionId })
      if (result.ok) done.current()
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="status" data-testid="work-log-undo" className="card flex h-8 shrink-0 items-center gap-2 pl-2.5 pr-1">
      <span className="min-w-0 truncate text-small text-graphite">{t(failed ? 'workLog.view.undoFailed' : 'workLog.view.deleted')}</span>
      {!failed && (
        <>
          <span aria-hidden="true" className="text-small text-graphite">
            ·
          </span>
          <button type="button" data-testid="work-log-undo-button" aria-disabled={busy} onClick={() => void undo()} className={undoButton}>
            {t('workLog.view.undo')}
          </button>
        </>
      )}
    </div>
  )
}

/**
 * The work log: the recorded sessions, or one session's detail in their place (like Redmine's
 * issues). Esc (or ‹ / ←) goes one step back: from the detail to its row, then to the integrations
 * row. The view is as tall as what it shows and the capsule fits it (ResizeObserver), up to
 * WORK_LOG_SIZE, where the list or the subtasks scroll. Live figures move once a minute.
 */
export function WorkLogView() {
  const t = useT()
  const now = useClock().getTime()
  const { entries, idlePauseMs } = useWorkLog()
  const { color } = useIntegration('workLog')
  const [openId, setOpenId] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ sessionId: string; expiresAt: number } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const detail = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | 'detail' | null>(null)

  // An entry deleted elsewhere (or never there) closes its detail.
  const opened = openId === null ? undefined : entries.find((entry) => entry.sessionId === openId)
  if (openId !== null && opened === undefined) setOpenId(null)

  // Opening a detail focuses it; closing it lands back on its row.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    if (target === 'detail') {
      detail.current?.focus()
      return
    }
    const row = entryRow(list.current, target) ?? entryRows(list.current)[0]
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  })

  // The tile that opened the view unmounts, or a focused control went away: keep focus in the panel
  // so Esc goes back to the row.
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    panel.current?.focus()
  })

  // Before paint, so the capsule and its content change size together.
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const report = () => setWorkLogViewHeight(Math.ceil(element.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      observer.disconnect()
      setWorkLogViewHeight(null)
    }
  }, [])

  const open = (sessionId: string) => {
    pendingFocus.current = 'detail'
    setOpenId(sessionId)
  }

  const stepBack = () => {
    if (openId !== null) {
      pendingFocus.current = openId
      setOpenId(null)
    } else {
      void window.notch.notch.back()
    }
  }

  const onDeleted = (sessionId: string) => {
    setOpenId(null)
    setUndo({ sessionId, expiresAt: Date.now() + UNDO_MS })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      stepBack()
      return
    }
    if (event.defaultPrevented || opened !== undefined) return
    if (event.key === 'ArrowDown' && !list.current?.contains(document.activeElement)) {
      const first = entryRows(list.current)[0]
      if (!first) return
      event.preventDefault()
      first.focus()
    }
  }

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches it.
    <div
      ref={panel}
      role="region"
      aria-label={t('integration.workLog')}
      data-testid="work-log-panel"
      data-body={opened ? 'detail' : entries.length === 0 ? 'empty' : 'list'}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Its own ceiling, not the capsule's: the capsule follows the view, so it can grow back.
      style={{ ...integrationStyle(color), maxHeight: WORK_LOG_SIZE.height - 2 }}
      className="flex flex-col gap-1.5 px-3 pb-2.5 pt-2 outline-none"
    >
      {opened ? (
        <WorkLogDetail key={opened.sessionId} ref={detail} entry={opened} now={now} idlePauseMs={idlePauseMs} onBack={stepBack} onDeleted={onDeleted} />
      ) : (
        <>
          <header className="flex h-8 shrink-0 items-center gap-1">
            <button type="button" data-testid="work-log-back" onClick={stepBack} aria-label={t('workLog.view.back')} title={t('workLog.view.back')} className={headerIconButton}>
              <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <ClipboardList size={14} strokeWidth={1.8} aria-hidden="true" className="ml-1.5 shrink-0 text-[color:var(--int)]" />
            <h2 className="ml-1 shrink-0 text-body font-medium text-chalk">{t('integration.workLog')}</h2>
          </header>
          {entries.length === 0 ? (
            <div role="status" data-testid="work-log-empty" className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
              <ClipboardList size={20} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
              <p className="text-body text-chalk">{t('workLog.view.empty')}</p>
              <p className="text-small text-graphite">{t('workLog.view.emptyHint')}</p>
            </div>
          ) : (
            <WorkLogList ref={list} entries={entries} now={now} idlePauseMs={idlePauseMs} onOpen={open} />
          )}
        </>
      )}
      {undo && <UndoDelete key={undo.sessionId} sessionId={undo.sessionId} expiresAt={undo.expiresAt} onDone={() => setUndo(null)} />}
    </div>
  )
}
