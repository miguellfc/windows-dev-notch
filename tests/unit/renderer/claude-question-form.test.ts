import { describe, expect, it } from 'vitest'
import { emptyDraft, formAnswers, questionFirst, toggleOption, toggleOther, withOtherText, type QuestionDraft } from '../../../src/renderer/notch/claude/question-form'
import type { ClaudeQuestion } from '../../../src/shared/claude/types'

const single: ClaudeQuestion = {
  question: 'Which one?',
  header: 'Pick',
  multiSelect: false,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
    { label: 'C', description: '' },
  ],
}
const multi: ClaudeQuestion = { ...single, question: 'Which ones?', multiSelect: true }

const apply = (draft: QuestionDraft, ...steps: ((d: QuestionDraft) => QuestionDraft)[]) => steps.reduce((d, step) => step(d), draft)

describe('question form', () => {
  it('single choice: an option replaces the previous one and "Other"', () => {
    const draft = apply(emptyDraft, (d) => toggleOption(d, false, 0), (d) => toggleOption(d, false, 2))
    expect(draft.selected).toEqual([2])
    const other = toggleOther(draft, false)
    expect(other).toMatchObject({ selected: [], otherOn: true })
    expect(toggleOption(other, false, 1)).toMatchObject({ selected: [1], otherOn: false })
    // Choosing the chosen option again keeps it (a radio never unchecks itself).
    expect(toggleOption(toggleOption(emptyDraft, false, 1), false, 1).selected).toEqual([1])
    expect(toggleOther(other, false).otherOn).toBe(true)
  })

  it('multiSelect: options and "Other" toggle independently, kept in display order', () => {
    const draft = apply(emptyDraft, (d) => toggleOption(d, true, 2), (d) => toggleOption(d, true, 0), (d) => toggleOther(d, true))
    expect(draft).toMatchObject({ selected: [0, 2], otherOn: true })
    expect(apply(draft, (d) => toggleOption(d, true, 2), (d) => toggleOther(d, true))).toMatchObject({ selected: [0], otherOn: false })
  })

  it('is incomplete until every question has an answer', () => {
    expect(formAnswers([single, multi], [emptyDraft, emptyDraft])).toBeNull()
    expect(formAnswers([single, multi], [toggleOption(emptyDraft, false, 1), emptyDraft])).toBeNull()
    expect(formAnswers([single, multi], [toggleOption(emptyDraft, false, 1), toggleOption(emptyDraft, true, 0)])).toEqual([
      { selected: [1] },
      { selected: [0] },
    ])
  })

  it('needs text for a chosen "Other": trimmed, sent alone or after the options, omitted when off', () => {
    const otherOn = toggleOther(emptyDraft, false)
    expect(formAnswers([single], [otherOn])).toBeNull()
    expect(formAnswers([single], [withOtherText(otherOn, '   ')])).toBeNull()
    expect(formAnswers([single], [withOtherText(otherOn, '  Mine  ')])).toEqual([{ selected: [], other: 'Mine' }])
    const both = withOtherText(toggleOther(toggleOption(emptyDraft, true, 1), true), 'also this')
    expect(formAnswers([multi], [both])).toEqual([{ selected: [1], other: 'also this' }])
    // An option is enough in multiSelect, but a chosen "Other" without text is not an answer yet.
    expect(formAnswers([multi], [toggleOther(toggleOption(emptyDraft, true, 1), true)])).toBeNull()
    // Text typed and then "Other" turned off is not sent.
    expect(formAnswers([multi], [toggleOther(both, true)])).toEqual([{ selected: [1] }])
  })

  it('follows the main-process rules: at most 500 characters, no line breaks', () => {
    const otherOn = toggleOther(emptyDraft, false)
    expect(formAnswers([single], [withOtherText(otherOn, 'x'.repeat(500))])).not.toBeNull()
    expect(formAnswers([single], [withOtherText(otherOn, 'x'.repeat(501))])).toBeNull()
    expect(formAnswers([single], [withOtherText(otherOn, 'a\nb')])).toBeNull()
  })

  it('never answers a different number of questions', () => {
    expect(formAnswers([single, multi], [toggleOption(emptyDraft, false, 0)])).toBeNull()
  })
})

describe('questionFirst (which Claude item the alert capsule shows)', () => {
  const q = (arrivedAt: number) => ({ arrivedAt })
  const p = (receivedAt: number) => ({ receivedAt })

  it('shows the earliest of the oldest permission and the oldest question', () => {
    expect(questionFirst([], [])).toBe(false)
    expect(questionFirst([p(1)], [])).toBe(false)
    expect(questionFirst([], [q(1)])).toBe(true)
    expect(questionFirst([p(3), p(5)], [q(4), q(2)])).toBe(true)
    expect(questionFirst([p(5), p(1)], [q(4)])).toBe(false)
  })
})
