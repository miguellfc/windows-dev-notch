import { ArrowLeft, ExternalLink, MailOpen, MailX, Paperclip, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { GmailMessageDetail } from '../../../shared/gmail/schema'
import type { MessageKey } from '../../../shared/i18n/messages'
import { attachmentsText, formatFullDate, senderParts, subjectText } from '../../shared/gmail/format'
import { useInFlight } from '../../shared/reminders/use-in-flight'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'
import { DeleteConfirm } from './DeleteConfirm'

type Load = { kind: 'loading' } | { kind: 'gone' } | { kind: 'error' } | { kind: 'ready'; detail: GmailMessageDetail }

const footerButton =
  'flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-control-sm px-2 text-label font-medium text-chalk transition-colors duration-150 hover:bg-veil-tile focus-inset aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent'
const noticeButton =
  'flex h-8 cursor-pointer items-center rounded-control border border-line bg-veil-tile px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover'

type ReaderAction = 'markRead' | 'delete'
const FAILED: Readonly<Record<ReaderAction, MessageKey>> = {
  markRead: 'gmail.row.markReadFailed',
  delete: 'gmail.row.deleteFailed',
}

/**
 * One message as plain text: header (back, sender, subject, full date), the body with its own
 * scroll (truncation notice, links, attachments under it) and a footer with Mark as read, Delete
 * (same inline confirmation) and Open in Gmail. Esc goes back to the list. Closing it makes main
 * forget the message's body and links.
 */
export function MessageReader({
  id,
  onBack,
  onMarkedRead,
  onDeleted,
}: {
  id: string
  onBack: () => void
  onMarkedRead: (id: string) => void
  onDeleted: (id: string) => void
}) {
  const t = useT()
  const language = useLanguage()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState<ReaderAction | null>(null)
  const inFlight = useInFlight()
  const root = useRef<HTMLDivElement>(null)
  const trash = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const backToTrash = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // The reader closed: main drops the open message (body and links); the list ids stay shown.
      void window.notch.gmail.closeMessage()
    }
  }, [])

  useEffect(() => {
    let current = true
    setLoad({ kind: 'loading' })
    window.notch.gmail
      .message({ id })
      .then((result) => {
        if (!current) return
        if (result.ok) setLoad({ kind: 'ready', detail: result.data })
        else setLoad({ kind: result.error.code === 'NOT_FOUND' ? 'gone' : 'error' })
      })
      .catch(() => {
        if (current) setLoad({ kind: 'error' })
      })
    return () => {
      current = false
    }
  }, [id, attempt])

  // Focus starts on the reader (not tabbable) so Esc and Tab work at once; it comes back to the
  // reader whenever the focused control disappears (Mark as read done, a state replaced).
  useLayoutEffect(() => {
    if (backToTrash.current && trash.current) {
      backToTrash.current = false
      trash.current.focus()
      return
    }
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    root.current?.focus()
  })

  const run = useCallback(
    (action: ReaderAction) => {
      setFailed(null)
      const call = async (): Promise<boolean> => {
        try {
          const result = await (action === 'delete' ? window.notch.gmail.delete({ id }) : window.notch.gmail.markRead({ id }))
          return result.ok
        } catch {
          return false
        }
      }
      void inFlight.run(id, call).then((worked) => {
        if (worked === undefined || !mounted.current) return
        if (!worked) {
          if (action === 'delete') setConfirming(false)
          setFailed(action)
          return
        }
        if (action === 'delete') {
          onDeleted(id)
          return
        }
        onMarkedRead(id)
        setLoad((current) => (current.kind === 'ready' ? { kind: 'ready', detail: { ...current.detail, unread: false } } : current))
      })
    },
    [id, inFlight, onDeleted, onMarkedRead],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    // Back to the list (the confirmation handles its own Esc first); never NotchApp's dismiss.
    event.preventDefault()
    event.stopPropagation()
    onBack()
  }

  const busy = inFlight.has(id)
  const openInGmail = () => void window.notch.gmail.open({ id })
  const detail = load.kind === 'ready' ? load.detail : null
  const sender = detail ? senderParts(detail.from, detail.fromAddress) : null

  return (
    <div
      ref={root}
      role="region"
      aria-label={t('gmail.reader.label')}
      aria-busy={load.kind === 'loading'}
      data-testid="gmail-reader"
      data-state={load.kind}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full flex-col gap-2 px-3 pb-2.5 pt-2 outline-none"
    >
      <header className="flex shrink-0 items-start gap-1">
        <button
          type="button"
          data-testid="gmail-reader-back"
          onClick={onBack}
          aria-label={t('gmail.reader.back')}
          title={t('gmail.reader.back')}
          className={`${headerIconButton} mt-1`}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {detail && sender && (
          <div className="ml-2 flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
            {/* Mail text is always plain text: React escapes it, nothing is parsed as HTML. */}
            <p className="flex min-w-0 items-baseline gap-1.5">
              <span className="sr-only">{t('gmail.reader.from')}: </span>
              <span data-testid="gmail-reader-from" className="min-w-0 shrink truncate text-body font-medium text-chalk">
                {sender.name}
              </span>
              {sender.address && <span className="min-w-0 shrink-[2] truncate text-small text-graphite">{sender.address}</span>}
            </p>
            <h2 data-testid="gmail-reader-subject" title={subjectText(detail.subject, language)} className="truncate text-body text-chalk">
              {subjectText(detail.subject, language)}
            </h2>
            <time dateTime={detail.date} className="tabular truncate text-label text-graphite">
              {formatFullDate(detail.date, language)}
            </time>
          </div>
        )}
      </header>

      {load.kind === 'loading' && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-card bg-veil p-3.5" aria-hidden="true">
          {['w-1/2', 'w-11/12', 'w-4/5', 'w-3/5'].map((width) => (
            <span key={width} className={`h-2.5 ${width} animate-pulse rounded-full bg-veil-tile motion-reduce:animate-none`} />
          ))}
          <p role="status" className="sr-only">
            {t('gmail.reader.loading')}
          </p>
        </div>
      )}

      {load.kind === 'gone' && (
        <div role="status" data-testid="gmail-reader-gone" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-4 text-center">
          <MailX size={20} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
          <p className="text-body text-chalk">{t('gmail.reader.gone')}</p>
          <button type="button" onClick={onBack} className={`${noticeButton} mt-1`}>
            {t('gmail.reader.back')}
          </button>
        </div>
      )}

      {load.kind === 'error' && (
        <div role="status" data-testid="gmail-reader-error" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-4 text-center">
          <MailX size={20} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
          <p className="text-body text-chalk">{t('gmail.reader.error')}</p>
          <div className="mt-1 flex gap-2">
            <button type="button" data-testid="gmail-reader-retry" onClick={() => setAttempt((n) => n + 1)} className={noticeButton}>
              {t('gmail.reader.retry')}
            </button>
            <button type="button" onClick={openInGmail} className={noticeButton}>
              {t('gmail.reader.openInGmail')}
            </button>
          </div>
        </div>
      )}

      {detail && (
        // The body scrolls on its own: the header and the footer never move. Focusable so the
        // keyboard can scroll it.
        <div
          data-testid="gmail-reader-body"
          tabIndex={0}
          aria-label={t('gmail.reader.label')}
          className="focus-inset min-h-0 flex-1 overflow-y-auto rounded-card bg-veil px-3.5 py-3"
        >
          {detail.truncated && (
            <p data-testid="gmail-reader-truncated" className="mb-2 flex items-center gap-1 text-label text-graphite">
              {t('gmail.reader.truncated')}
              <span aria-hidden="true">·</span>
              <button type="button" onClick={openInGmail} className="cursor-pointer rounded-control-sm font-medium text-chalk underline-offset-2 hover:underline focus-inset">
                {t('gmail.reader.openInGmail')}
              </button>
            </p>
          )}
          <p className="whitespace-pre-wrap break-words text-body text-chalk [overflow-wrap:anywhere]">{detail.body}</p>
          {detail.links.length > 0 && (
            <section aria-labelledby="gmail-reader-links" className="mt-4">
              <h3 id="gmail-reader-links" className="mb-1 text-caps font-medium uppercase text-graphite">
                {t('gmail.reader.links')}
              </h3>
              <ul className="-mx-1.5 flex flex-col">
                {detail.links.map((link, index) => (
                  <li key={`${index}-${link.url}`} className="flex">
                    <button
                      type="button"
                      data-testid="gmail-reader-link"
                      title={link.url}
                      onClick={() => void window.notch.gmail.openLink({ id: detail.id, index })}
                      className="focus-inset flex min-h-6 w-full min-w-0 cursor-pointer flex-col rounded-control-sm px-1.5 py-1 text-left transition-colors duration-150 hover:bg-veil-tile"
                    >
                      {link.text.trim() !== '' && <span className="w-full truncate text-small text-chalk">{link.text}</span>}
                      <span className="w-full truncate font-mono text-label text-graphite">{link.url}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail.attachments > 0 && (
            <p data-testid="gmail-reader-attachments" className="mt-3 flex items-center gap-1.5 text-label text-graphite">
              <Paperclip size={12} strokeWidth={1.8} aria-hidden="true" />
              {attachmentsText(detail.attachments, language)}
            </p>
          )}
        </div>
      )}

      {detail && (
        <footer className="flex h-6 shrink-0 items-center gap-1 px-1">
          {confirming ? (
            <DeleteConfirm
              busy={busy}
              className="min-w-0 flex-1 pl-2"
              onCancel={() => {
                backToTrash.current = true
                setConfirming(false)
              }}
              onConfirm={() => run('delete')}
            />
          ) : (
            <>
              {detail.unread && (
                <button type="button" data-testid="gmail-reader-mark-read" aria-disabled={busy} onClick={() => !busy && run('markRead')} className={footerButton}>
                  <MailOpen size={12} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
                  {t('gmail.row.markRead')}
                </button>
              )}
              <button
                ref={trash}
                type="button"
                data-testid="gmail-reader-delete"
                aria-disabled={busy}
                onClick={() => {
                  if (busy) return
                  setFailed(null)
                  setConfirming(true)
                }}
                className={footerButton}
              >
                <Trash2 size={12} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
                {t('gmail.row.delete')}
              </button>
              {failed && (
                <span role="status" data-testid="gmail-reader-action-error" className="ml-1 min-w-0 truncate text-label text-fail">
                  {t(FAILED[failed])}
                </span>
              )}
              <button type="button" data-testid="gmail-reader-open" onClick={openInGmail} className={`${footerButton} ml-auto`}>
                {t('gmail.reader.openInGmail')}
                <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  )
}
