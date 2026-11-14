import { describe, expect, it } from 'vitest'
import {
  askUserQuestionInputSchema,
  buildAnswers,
  displayQuestions,
  displayText,
  questionAnswerInputSchema,
  questionResponseBody,
  type AskQuestion,
} from '../../../src/shared/claude/questions'

const opt = (label: string, description = `${label} desc`) => ({ label, description })

const q = (question: string, labels: string[], multiSelect = false, header = 'H'): AskQuestion => ({
  question,
  header,
  multiSelect,
  options: labels.map((l) => opt(l)),
})

const single = q('Fruit?', ['Apple', 'Pear', 'Plum'])
const multi = q('Colours?', ['Red', 'Green', 'Blue'], true)

describe('askUserQuestionInputSchema', () => {
  const valid = (questions: unknown) => askUserQuestionInputSchema.safeParse({ questions }).success

  it('accepts 1 to 4 questions and rejects 0 or 5', () => {
    expect(valid([])).toBe(false)
    expect(valid([q('a', ['x', 'y'])])).toBe(true)
    expect(valid(['a', 'b', 'c', 'd'].map((t) => q(t, ['x', 'y'])))).toBe(true)
    expect(valid(['a', 'b', 'c', 'd', 'e'].map((t) => q(t, ['x', 'y'])))).toBe(false)
  })

  it('accepts 2 to 4 options and rejects 1 or 5', () => {
    expect(valid([q('a', ['x'])])).toBe(false)
    expect(valid([q('a', ['x', 'y'])])).toBe(true)
    expect(valid([q('a', ['w', 'x', 'y', 'z'])])).toBe(true)
    expect(valid([q('a', ['v', 'w', 'x', 'y', 'z'])])).toBe(false)
  })

  it('enforces the text limits at the edge and beyond', () => {
    expect(valid([q('x'.repeat(500), ['a', 'b'])])).toBe(true)
    expect(valid([q('x'.repeat(501), ['a', 'b'])])).toBe(false)
    expect(valid([q('a', ['a', 'b'], false, 'h'.repeat(60))])).toBe(true)
    expect(valid([q('a', ['a', 'b'], false, 'h'.repeat(61))])).toBe(false)
    expect(valid([q('a', ['l'.repeat(120), 'b'])])).toBe(true)
    expect(valid([q('a', ['l'.repeat(121), 'b'])])).toBe(false)
    expect(valid([{ ...q('a', []), options: [opt('a', 'd'.repeat(300)), opt('b')] }])).toBe(true)
    expect(valid([{ ...q('a', []), options: [opt('a', 'd'.repeat(301)), opt('b')] }])).toBe(false)
  })

  it('rejects empty question texts and labels, wrong types and missing fields', () => {
    expect(valid([q('', ['a', 'b'])])).toBe(false)
    expect(valid([q('a', ['', 'b'])])).toBe(false)
    expect(valid([{ ...q('a', ['x', 'y']), multiSelect: 'yes' }])).toBe(false)
    expect(valid([{ question: 'a', options: [opt('x'), opt('y')], multiSelect: false }])).toBe(false)
    expect(askUserQuestionInputSchema.safeParse(null).success).toBe(false)
    expect(askUserQuestionInputSchema.safeParse({}).success).toBe(false)
  })

  it('rejects two questions with the same text (answers are keyed by it)', () => {
    expect(valid([q('Same?', ['a', 'b']), q('Same?', ['c', 'd'])])).toBe(false)
  })

  it('validates input with unknown keys at every level (they do not make it invalid)', () => {
    const raw = { extra: 1, questions: [{ ...q('a', ['x', 'y']), extra: 2, options: [{ ...opt('x'), extra: 3 }, opt('y')] }] }
    expect(askUserQuestionInputSchema.safeParse(raw).success).toBe(true)
  })
})

describe('questionAnswerInputSchema', () => {
  it('accepts ids and per-question selections with an optional free text', () => {
    expect(questionAnswerInputSchema.safeParse({ id: 'q1', answers: [{ selected: [0] }, { selected: [], other: 'x' }] }).success).toBe(true)
  })

  it('rejects unknown keys, non-integer or negative indices and empty ids', () => {
    expect(questionAnswerInputSchema.safeParse({ id: 'q1', answers: [{ selected: [0] }], extra: 1 }).success).toBe(false)
    expect(questionAnswerInputSchema.safeParse({ id: 'q1', answers: [{ selected: [0], label: 'x' }] }).success).toBe(false)
    expect(questionAnswerInputSchema.safeParse({ id: 'q1', answers: [{ selected: [1.5] }] }).success).toBe(false)
    expect(questionAnswerInputSchema.safeParse({ id: 'q1', answers: [{ selected: [-1] }] }).success).toBe(false)
    expect(questionAnswerInputSchema.safeParse({ id: '', answers: [{ selected: [0] }] }).success).toBe(false)
    expect(questionAnswerInputSchema.safeParse({ id: 'q1', answers: [] }).success).toBe(false)
  })
})

describe('buildAnswers', () => {
  it('maps a single-choice question to its label', () => {
    expect(buildAnswers([single], [{ selected: [1] }])).toEqual({ 'Fruit?': 'Pear' })
  })

  it('joins multiSelect labels with ", " in the order the options are shown, whatever the selection order', () => {
    expect(buildAnswers([multi], [{ selected: [0, 2] }])).toEqual({ 'Colours?': 'Red, Blue' })
    expect(buildAnswers([multi], [{ selected: [2, 0, 1] }])).toEqual({ 'Colours?': 'Red, Green, Blue' })
  })

  it('sends a trimmed free text alone', () => {
    expect(buildAnswers([single], [{ selected: [], other: '  Mango  ' }])).toEqual({ 'Fruit?': 'Mango' })
    expect(buildAnswers([multi], [{ selected: [], other: 'Teal' }])).toEqual({ 'Colours?': 'Teal' })
  })

  it('appends the free text after the joined labels in multiSelect (commas are not escaped)', () => {
    expect(buildAnswers([multi], [{ selected: [1], other: 'Teal, or Cyan' }])).toEqual({ 'Colours?': 'Green, Teal, or Cyan' })
  })

  it('answers several questions in order', () => {
    expect(buildAnswers([single, multi], [{ selected: [0] }, { selected: [1, 0] }])).toEqual({
      'Fruit?': 'Apple',
      'Colours?': 'Red, Green',
    })
  })

  it('rejects a count that does not match the questions', () => {
    expect(buildAnswers([single, multi], [{ selected: [0] }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [0] }, { selected: [0] }])).toBeNull()
  })

  it('rejects repeated or out-of-range indices', () => {
    expect(buildAnswers([multi], [{ selected: [0, 0] }])).toBeNull()
    expect(buildAnswers([multi], [{ selected: [3] }])).toBeNull()
    expect(buildAnswers([multi], [{ selected: [-1] }])).toBeNull()
    expect(buildAnswers([multi], [{ selected: [0.5] }])).toBeNull()
  })

  it('needs exactly one option or a free text for a single-choice question', () => {
    expect(buildAnswers([single], [{ selected: [0, 1] }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [0], other: 'Mango' }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [] }])).toBeNull()
  })

  it('needs at least an option or a free text for multiSelect', () => {
    expect(buildAnswers([multi], [{ selected: [] }])).toBeNull()
  })

  it('rejects a free text that is blank, has line breaks or is longer than 500 after trimming', () => {
    expect(buildAnswers([single], [{ selected: [], other: '   ' }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [], other: 'a\nb' }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [], other: 'a\rb' }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [], other: `a${String.fromCharCode(0x2028)}b` }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [], other: 'x'.repeat(501) }])).toBeNull()
    expect(buildAnswers([single], [{ selected: [], other: ` ${'x'.repeat(500)} ` }])).toEqual({ 'Fruit?': 'x'.repeat(500) })
  })
})

describe('questionResponseBody', () => {
  it('is the exact PreToolUse allow JSON with the original input and the answers', () => {
    const rawInput = { questions: [single, multi] }
    const answers = { 'Fruit?': 'Pear', 'Colours?': 'Red, Blue' }
    expect(questionResponseBody(rawInput, answers)).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { questions: [single, multi], answers },
        },
      }),
    )
  })

  it('echoes unknown question, option and top-level keys exactly as received', () => {
    const rawInput = {
      metadata: { source: 'x' },
      questions: [{ extra: 2, question: 'Fruit?', header: 'H', options: [{ label: 'A', description: 'a', icon: '*' }, { label: 'B', description: 'b' }], multiSelect: false }],
    }
    const snapshot = JSON.stringify(rawInput)
    const body = JSON.parse(questionResponseBody(rawInput, { 'Fruit?': 'A' })) as { hookSpecificOutput: { updatedInput: unknown } }
    expect(body.hookSpecificOutput.updatedInput).toEqual({ ...rawInput, answers: { 'Fruit?': 'A' } })
    expect(JSON.stringify(rawInput)).toBe(snapshot)
  })

  it('replaces an answers key already present in the input', () => {
    const body = JSON.parse(questionResponseBody({ questions: [single], answers: { stale: 'x' } }, { 'Fruit?': 'Pear' })) as {
      hookSpecificOutput: { updatedInput: { answers: unknown } }
    }
    expect(body.hookSpecificOutput.updatedInput.answers).toEqual({ 'Fruit?': 'Pear' })
  })
})

describe('displayText / displayQuestions', () => {
  const ch = (cp: number) => String.fromCodePoint(cp)

  it('strips bidi overrides and isolates, zero-width and control characters', () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(ch).join('')
    expect(displayText(`a${bidi}b${ch(0x200b)}c${ch(0)}${ch(7)}${ch(0x1b)}${ch(0x7f)}${ch(0x9b)}d${ch(0xfeff)}`)).toBe('abcd')
  })

  it('keeps newlines and tabs and turns U+2028/U+2029 into newlines', () => {
    expect(displayText(`a\nb\tc${ch(0x2028)}d${ch(0x2029)}e\r\nf`)).toBe('a\nb\tc\nd\ne\nf')
  })

  it('maps every text of the questions, single-lines headers and labels, and never touches the input', () => {
    const raw: AskQuestion[] = [
      { question: `Pick${ch(0x202e)}?`, header: 'H\n1', multiSelect: true, options: [opt(`A${ch(0x2066)}\nB`,`d${ch(0x200f)}`), opt('C')] },
    ]
    const snapshot = JSON.stringify(raw)
    expect(displayQuestions(raw)).toEqual([
      { question: 'Pick?', header: 'H 1', multiSelect: true, options: [{ label: 'A B', description: 'd' }, opt('C')] },
    ])
    expect(JSON.stringify(raw)).toBe(snapshot)
  })
})
