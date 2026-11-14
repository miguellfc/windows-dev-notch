import { Check, CircleSlash } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { QUESTION_LIMITS } from '../../../shared/claude/questions'
import type { ClaudeQuestion, PendingQuestionView } from '../../../shared/claude/types'
import { useQuestions } from '../../shared/questions-store'
import { useT } from '../../shared/use-t'
import { radioKeyTarget } from '../../ui/roving'
import { emptyDraft, formAnswers, toggleOption, toggleOther, withOtherText, type QuestionDraft } from './question-form'

/** How long "Answer sent" stays before the card moves on (next pending item, or closes). */
const SENT_MS = 1_000
/** "No longer pending" is news the user did not expect: a little longer to read it. */
const GONE_MS = 1_600

type Outcome = 'sent' | 'gone'

/** Up/Down (and Home/End) move between the items of one question; Left/Right are left alone. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * The panel card for the earliest pending Claude question (`AskUserQuestion`). Nothing is sent
 * without an explicit Send click or Ctrl+Enter; Esc (NotchApp) closes the panel without answering.
 * The shown question is latched by id: if it stops being pending (answered elsewhere, session ended)
 * the card says so instead of swapping in another question under the user's hands.
 */
export function QuestionCard() {
  const t = useT()
  const questions = useQuestions((store) => store.questions)
  const [shown, setShown] = useState<PendingQuestionView | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [sending, setSending] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const head = questions?.[0]
  const stillPending = shown !== null && (questions?.some((question) => question.id === shown.id) ?? false)
  // Adjusted during render (React's pattern for derived state): latch the head, or notice the latched one left.
  if (!outcome && !leaving && questions !== null) {
    if (shown === null && head) setShown(head)
    else if (shown === null || (!stillPending && !sending)) setOutcome('gone')
  }

  useEffect(() => {
    if (!outcome) return
    const timer = setTimeout(
      () => {
        // Main moves to the next pending item (either kind) or closes the panel; the mode change
        // reaches this window before the reply, so another question never flashes in between.
        void window.notch.notch.request({ intent: 'next' }).finally(() => {
          setShown(null)
          setOutcome(null)
          setFailed(false)
        })
      },
      outcome === 'sent' ? SENT_MS : GONE_MS,
    )
    return () => clearTimeout(timer)
  }, [outcome])

  if (questions === null) return null

  const send = (answers: NonNullable<ReturnType<typeof formAnswers>>) => {
    if (!shown || sending || outcome || leaving) return
    setSending(true)
    setFailed(false)
    window.notch.claude
      .answer({ id: shown.id, answers })
      .then((result) => {
        if (result.ok) setOutcome(result.data)
        else setFailed(true)
      })
      .catch(() => setFailed(true))
      .finally(() => setSending(false))
  }

  const answerInClaude = () => {
    if (!shown || sending || outcome || leaving) return
    setLeaving(true)
    // Gives the question back to Claude's own dialog (and brings Claude forward), then closes.
    void window.notch.claude
      .releaseQuestion({ id: shown.id })
      .finally(() => {
        void window.notch.notch.request({ intent: 'dismiss' }).finally(() => setLeaving(false))
      })
  }

  const pendingCount = questions.length
  const index = shown ? questions.findIndex((question) => question.id === shown.id) : -1

  return (
    <div data-testid="claude-question" className="flex h-full flex-col px-5 pb-4 pt-4">
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label font-medium text-wait">{t('claude.question.title')}</p>
          {/* Claude's texts are always plain text: React escapes them. */}
          <p className="mt-1 truncate text-title font-medium text-chalk">{shown?.project}</p>
        </div>
        {!outcome && pendingCount > 1 && index >= 0 && (
          <span data-testid="claude-question-counter" className="tabular shrink-0 pt-0.5 text-label text-graphite">
            {t('claude.question.counter', { index: index + 1, total: pendingCount })}
          </span>
        )}
      </header>
      {/* Always mounted, so screen readers announce the outcome when its text appears. */}
      <p role="status" data-testid="claude-question-status" className="sr-only">
        {outcome ? t(outcome === 'sent' ? 'claude.question.sent' : 'claude.question.gone') : ''}
      </p>
      {outcome || !shown ? (
        <OutcomeMessage outcome={outcome ?? 'gone'} />
      ) : (
        <QuestionForm
          key={shown.id}
          question={shown}
          busy={sending || leaving}
          failed={failed}
          onSend={send}
          onAnswerInClaude={answerInClaude}
        />
      )}
    </div>
  )
}

function OutcomeMessage({ outcome }: { outcome: Outcome }) {
  const t = useT()
  const Icon = outcome === 'sent' ? Check : CircleSlash
  return (
    <div
      data-testid={`claude-question-${outcome}`}
      // Announced by the card's persistent status line; this is the visual copy.
      aria-hidden="true"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center"
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" className={outcome === 'sent' ? 'text-ok' : 'text-graphite'} />
      <p className="text-body text-chalk">{t(outcome === 'sent' ? 'claude.question.sent' : 'claude.question.gone')}</p>
    </div>
  )
}

interface QuestionFormProps {
  question: PendingQuestionView
  busy: boolean
  failed: boolean
  onSend: (answers: NonNullable<ReturnType<typeof formAnswers>>) => void
  onAnswerInClaude: () => void
}

/** The questions (their own scroll), the error line and the footer. Keyed by the question id. */
function QuestionForm({ question, busy, failed, onSend, onAnswerInClaude }: QuestionFormProps) {
  const t = useT()
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => question.questions.map(() => emptyDraft))
  const answers = formAnswers(question.questions, drafts)
  const canSend = answers !== null && !busy

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    // Also keeps Ctrl+Enter from activating the focused option or button.
    event.preventDefault()
    if (canSend) onSend(answers)
  }

  const setDraft = (index: number, draft: QuestionDraft) =>
    setDrafts((current) => current.map((existing, i) => (i === index ? draft : existing)))

  const button =
    'h-9 flex-1 cursor-pointer rounded-control px-4 text-body font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50'

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div data-testid="claude-question-body" className="-mx-2 mt-3 min-h-0 flex-1 overflow-y-auto px-2">
        {question.questions.map((item, index) => (
          <QuestionBlock
            key={index}
            question={item}
            draft={drafts[index] ?? emptyDraft}
            first={index === 0}
            disabled={busy}
            onChange={(draft) => setDraft(index, draft)}
          />
        ))}
      </div>
      {failed && (
        <p role="alert" className="mt-2 shrink-0 text-label text-fail">
          {t('claude.question.error')}
        </p>
      )}
      <div className="mt-3 flex shrink-0 gap-2">
        <button
          type="button"
          data-testid="claude-question-reply"
          disabled={busy}
          onClick={onAnswerInClaude}
          className={`${button} border border-line bg-veil-tile text-chalk hover:bg-veil-hover`}
        >
          {t('claude.question.reply')}
        </button>
        <button
          type="button"
          data-testid="claude-question-send"
          disabled={!canSend}
          aria-keyshortcuts="Control+Enter"
          title={t('claude.question.sendHint')}
          onClick={() => {
            if (canSend) onSend(answers)
          }}
          className={`${button} bg-ice text-abyss hover:brightness-110`}
        >
          {t('claude.question.send')}
        </button>
      </div>
    </div>
  )
}

interface QuestionBlockProps {
  question: ClaudeQuestion
  draft: QuestionDraft
  /** The first question takes the initial focus (its first option). */
  first: boolean
  disabled: boolean
  onChange: (draft: QuestionDraft) => void
}

/**
 * One question: its header, text and options as a radio group (single choice) or a group of check
 * boxes (multiSelect), with "Other…" always last. One Tab stop per question; Up/Down move between
 * its items and Space (or a click) picks one. A picked "Other…" shows a one-line text field.
 */
function QuestionBlock({ question, draft, first, disabled, onChange }: QuestionBlockProps) {
  const t = useT()
  const titleId = useId()
  const [active, setActive] = useState(0)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const focusOther = useRef(false)
  const count = question.options.length + 1
  const otherIndex = question.options.length
  const multi = question.multiSelect

  useEffect(() => {
    // No scroll: the card mounts while the capsule still morphs, and scrolling the focused option
    // into that small box would leave the questions scrolled past their start.
    if (first) items.current[0]?.focus({ preventScroll: true })
  }, [first])

  const pick = (index: number) => {
    if (disabled) return
    if (index === otherIndex) {
      const next = toggleOther(draft, multi)
      // Turning "Other…" on moves the focus into its field, ready to type.
      if (next.otherOn && !draft.otherOn) focusOther.current = true
      onChange(next)
    } else {
      onChange(toggleOption(draft, multi, index))
    }
    setActive(index)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!MOVE_KEYS.has(event.key)) return
    const focused = items.current.findIndex((item) => item === event.target)
    const to = radioKeyTarget(event.key, focused === -1 ? active : focused, count)
    if (to === null) return
    event.preventDefault()
    setActive(to)
    items.current[to]?.focus()
  }

  const checked = (index: number) => (index === otherIndex ? draft.otherOn : draft.selected.includes(index))
  const role = multi ? 'checkbox' : 'radio'
  const labels = [...question.options, { label: t('claude.question.other'), description: '' }]

  return (
    <section aria-labelledby={titleId} className={first ? '' : 'mt-4 border-t border-line pt-4'}>
      {(question.header || multi) && (
        <p className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-caps font-medium uppercase text-graphite">{question.header}</span>
          {multi && <span className="shrink-0 text-label text-graphite">{t('claude.question.multi')}</span>}
        </p>
      )}
      <p id={titleId} className="mt-1 break-words text-body font-medium text-chalk">
        {question.question}
      </p>
      <div role={multi ? 'group' : 'radiogroup'} aria-labelledby={titleId} onKeyDown={onKeyDown} className="mt-1.5 flex flex-col gap-0.5">
        {labels.map((option, index) => (
          <button
            key={index}
            ref={(element) => {
              items.current[index] = element
            }}
            type="button"
            role={role}
            aria-checked={checked(index)}
            aria-disabled={disabled || undefined}
            tabIndex={index === active ? 0 : -1}
            data-testid="claude-question-option"
            onClick={() => pick(index)}
            className="focus-inset flex w-full cursor-pointer items-start gap-2.5 rounded-control px-2.5 py-1 text-left transition-colors duration-150 hover:bg-veil-tile aria-checked:bg-veil"
          >
            <Indicator multi={multi} checked={checked(index)} />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-body text-chalk">{option.label}</span>
              {option.description && <span className="block break-words text-small leading-snug text-graphite">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>
      {draft.otherOn && (
        <input
          ref={(element) => {
            if (element && focusOther.current) {
              focusOther.current = false
              element.focus()
            }
          }}
          type="text"
          data-testid="claude-question-other"
          aria-label={t('claude.question.otherLabel')}
          // Which question this field answers, when several are shown.
          aria-describedby={titleId}
          placeholder={t('claude.question.otherPlaceholder')}
          maxLength={QUESTION_LIMITS.other}
          value={draft.other}
          disabled={disabled}
          onChange={(event) => onChange(withOtherText(draft, event.target.value))}
          className="mt-1.5 ml-9 h-8 w-[calc(100%-2.25rem)] rounded-control border border-line bg-veil px-3 text-body text-chalk placeholder:text-graphite"
        />
      )}
    </section>
  )
}

/** The radio dot or check box in front of an option: Azul Hielo when picked (selection). */
function Indicator({ multi, checked }: { multi: boolean; checked: boolean }) {
  const shape = multi ? 'rounded-key' : 'rounded-full'
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${shape} ${
        checked ? 'border-ice bg-ice' : 'border-graphite bg-transparent'
      }`}
    >
      {checked && (multi ? <Check size={11} strokeWidth={3} className="text-abyss" /> : <span className="size-1.5 rounded-full bg-abyss" />)}
    </span>
  )
}
