import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHookEvent } from '../../../src/shared/claude/hook-events'

const fixtureDir = join(__dirname, '..', 'fixtures', 'claude-hooks')
const fixtures = readdirSync(fixtureDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({ file, raw: JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as Record<string, unknown> }))

/** Builds a character from its code point, so invisible characters stay visible in this source. */
const u = (codePoint: number): string => String.fromCodePoint(codePoint)

const permission = (toolInput: unknown): Record<string, unknown> => ({
  session_id: 's1',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: toolInput,
})

describe('parseHookEvent', () => {
  it('has a fixture for every hook event name', () => {
    expect(fixtures.map((f) => f.raw.hook_event_name).sort()).toEqual(
      [
        'Notification',
        'PermissionDenied',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'Stop',
        'StopFailure',
        'SubagentStart',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort(),
    )
  })

  it.each(fixtures)('parses fixture $file', ({ raw }) => {
    const event = parseHookEvent(raw)
    expect(event).not.toBeNull()
    expect(event?.name).toBe(raw.hook_event_name)
    expect(event?.sessionId).toBe(raw.session_id)
    expect(event?.cwd).toBe(raw.cwd)
  })

  it('never exposes sensitive payload fields', () => {
    for (const { raw } of fixtures) {
      const keys = Object.keys(parseHookEvent(raw) ?? {})
      for (const forbidden of ['prompt', 'message', 'tool_response', 'toolResponse', 'last_assistant_message', 'lastAssistantMessage', 'toolInput']) {
        expect(keys).not.toContain(forbidden)
      }
    }
  })

  it('maps tool name, notification type and reason', () => {
    const byName = (name: string) => parseHookEvent(fixtures.find((f) => f.raw.hook_event_name === name)?.raw)
    expect(byName('PreToolUse')?.toolName).toBe('Bash')
    expect(byName('Notification')?.notificationType).toBe('permission_prompt')
    expect(byName('SessionEnd')?.reason).toBe('other')
  })

  it('only produces a preview for PermissionRequest', () => {
    expect(parseHookEvent({ ...permission({ command: 'ls' }), hook_event_name: 'PreToolUse' })?.preview).toBeUndefined()
    expect(parseHookEvent(permission({ command: 'ls' }))?.preview).toBe('ls')
  })

  it('ignores unknown fields', () => {
    const event = parseHookEvent({ session_id: 's1', hook_event_name: 'Stop', brand_new_field: { a: 1 } })
    expect(event).toEqual({ name: 'Stop', sessionId: 's1' })
  })

  it('returns null without session_id or with an unknown event name', () => {
    expect(parseHookEvent({ hook_event_name: 'Stop' })).toBeNull()
    expect(parseHookEvent({ session_id: '', hook_event_name: 'Stop' })).toBeNull()
    expect(parseHookEvent({ session_id: 's1', hook_event_name: 'Nope' })).toBeNull()
    expect(parseHookEvent({ session_id: 's1' })).toBeNull()
    expect(parseHookEvent(null)).toBeNull()
    expect(parseHookEvent('text')).toBeNull()
    expect(parseHookEvent([])).toBeNull()
  })

  describe('permission preview', () => {
    it('shows the command when tool_input.command is a string', () => {
      expect(parseHookEvent(permission({ command: 'git status', file_path: '/a', url: 'http://x' }))?.preview).toBe('git status')
    })

    it('shows the whole tool_input as compact JSON for every other tool (Write content is visible)', () => {
      const write = parseHookEvent({
        ...permission({ file_path: '/fake/a.ts', content: 'evil();' }),
        tool_name: 'Write',
      })
      expect(write?.preview).toBe('{"file_path":"/fake/a.ts","content":"evil();"}')
      expect(parseHookEvent(permission({ url: 'https://example.test/', prompt: 'x' }))?.preview).toBe(
        '{"url":"https://example.test/","prompt":"x"}',
      )
      expect(parseHookEvent(permission({ pattern: 'foo', n: 2 }))?.preview).toBe('{"pattern":"foo","n":2}')
      expect(parseHookEvent(permission({ command: 42 }))?.preview).toBe('{"command":42}')
    })

    it('has no preview without tool_input', () => {
      expect(parseHookEvent({ session_id: 's1', hook_event_name: 'PermissionRequest' })?.preview).toBeUndefined()
    })

    it('strips control characters except newline and tab', () => {
      const preview = parseHookEvent(permission({ command: 'a\u0000b\u001b[31mc\r\nd\te\u007ff\u0085g' }))?.preview
      expect(preview).toBe('ab[31mc\nd\tefg')
    })

    it('strips bidi overrides/isolates, zero-width and other format characters', () => {
      const command = `echo ${u(0x202e)}safe${u(0x202c)}${u(0x2066)}x${u(0x2069)} ${u(0x200b)}z${u(0x200f)}w${u(0x2060)}j${u(0x2064)}k${u(0xfeff)}end${u(0xad)}`
      expect(parseHookEvent(permission({ command }))?.preview).toBe('echo safex zwjkend')
    })

    it('turns U+2028 and U+2029 into newlines', () => {
      expect(parseHookEvent(permission({ command: `a${u(0x2028)}b${u(0x2029)}c` }))?.preview).toBe('a\nb\nc')
    })

    it('collapses 3 or more consecutive blank lines into a single ⋯ line', () => {
      expect(parseHookEvent(permission({ command: 'a\n\nb' }))?.preview).toBe('a\n\nb')
      expect(parseHookEvent(permission({ command: 'a\n\n\nb' }))?.preview).toBe('a\n\n\nb')
      expect(parseHookEvent(permission({ command: `safe\n${'\n'.repeat(200)}rm -rf /` }))?.preview).toBe('safe\n⋯\nrm -rf /')
      // Whitespace-only and U+2028 "lines" count as blank too.
      expect(parseHookEvent(permission({ command: `a\n \n\t\n${u(0x2028)}${u(0x2028)}b` }))?.preview).toBe('a\n⋯\nb')
    })

    it('collapses very long runs of spaces or tabs', () => {
      expect(parseHookEvent(permission({ command: `ls${' '.repeat(500)}; rm -rf /` }))?.preview).toBe('ls ⋯ ; rm -rf /')
      expect(parseHookEvent(permission({ command: `    indented` }))?.preview).toBe('    indented')
    })

    it('cuts to 2000 characters and reports the truncation and the full length', () => {
      const event = parseHookEvent(permission({ command: 'x'.repeat(2400) }))
      expect(event?.preview).toHaveLength(2000)
      expect(event?.previewTruncated).toBe(true)
      expect(event?.previewLength).toBe(2400)
    })

    it('is not truncated at exactly 2000 characters', () => {
      const event = parseHookEvent(permission({ command: 'x'.repeat(2000) }))
      expect(event?.previewTruncated).toBe(false)
      expect(event?.previewLength).toBe(2000)
    })

    it('clamps and sanitises tool_name to 64 characters', () => {
      expect(parseHookEvent({ ...permission({ command: 'ls' }), tool_name: `mcp__${u(0x202e)}evil${'x'.repeat(100)}` })?.toolName).toBe(
        `mcp__evil${'x'.repeat(55)}`,
      )
      expect(parseHookEvent({ ...permission({ command: 'ls' }), tool_name: 'Bash' })?.toolName).toBe('Bash')
    })
  })

  describe('tool call identity', () => {
    it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])('reads tool_use_id on %s', (name) => {
      expect(parseHookEvent({ session_id: 's1', hook_event_name: name, tool_name: 'Bash', tool_use_id: 'tu1' })?.toolUseId).toBe('tu1')
    })

    it('ignores tool_use_id on other events and reads agent_id when present', () => {
      expect(parseHookEvent({ session_id: 's1', hook_event_name: 'Stop', tool_use_id: 'tu1' })?.toolUseId).toBeUndefined()
      expect(parseHookEvent({ session_id: 's1', hook_event_name: 'PreToolUse', agent_id: 'ag1' })?.agentId).toBe('ag1')
      expect(parseHookEvent({ session_id: 's1', hook_event_name: 'PermissionRequest', agent_id: 'ag1' })?.agentId).toBe('ag1')
      expect(parseHookEvent({ session_id: 's1', hook_event_name: 'PreToolUse', agent_id: 7 })?.agentId).toBeUndefined()
    })

    it('keeps no askUserQuestion on PreToolUse of other tools or on other events', () => {
      const toolInput = { questions: [{ question: 'a', header: 'h', multiSelect: false, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }] }] }
      expect('askUserQuestion' in (parseHookEvent({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput }) ?? {})).toBe(false)
      expect('askUserQuestionRaw' in (parseHookEvent({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput }) ?? {})).toBe(false)
      expect('askUserQuestion' in (parseHookEvent({ session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: toolInput }) ?? {})).toBe(false)
      expect('askUserQuestion' in (parseHookEvent({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: toolInput }) ?? {})).toBe(false)
    })

    it('parses PostToolUseFailure', () => {
      expect(parseHookEvent({ session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' })).toMatchObject({
        name: 'PostToolUseFailure',
        toolName: 'Bash',
      })
    })
  })

  describe('AskUserQuestion', () => {
    const question = { question: 'Fruit?', header: 'Pick', multiSelect: false, options: [{ label: 'Apple', description: 'red' }, { label: 'Pear', description: 'green' }] }
    const ask = (toolInput: unknown): Record<string, unknown> => ({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu1',
      tool_input: toolInput,
    })

    it('keeps the validated questions and the tool_use_id', () => {
      expect(parseHookEvent(ask({ questions: [question] }))).toEqual({
        name: 'PreToolUse',
        sessionId: 's1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tu1',
        askUserQuestion: { questions: [question] },
        askUserQuestionRaw: { questions: [question] },
      })
    })

    it('carries the raw tool_input (unknown keys included) next to the validated view', () => {
      const raw = { meta: 1, questions: [{ ...question, extra: true, options: [{ ...question.options[0], icon: 'x' }, question.options[1]] }] }
      const event = parseHookEvent(ask(raw))
      expect(event?.askUserQuestionRaw).toEqual(raw)
      expect(event?.askUserQuestion).toEqual({ questions: [question] })
    })

    it('keeps the raw question texts unchanged (answers are keyed by them)', () => {
      const raw = { ...question, question: 'Line one\n\n\n\nLine two?' }
      expect(parseHookEvent(ask({ questions: [raw] }))?.askUserQuestion).toEqual({ questions: [raw] })
    })

    it('is null when tool_input does not fit the schema', () => {
      expect(parseHookEvent(ask({ questions: [] }))?.askUserQuestion).toBeNull()
      expect(parseHookEvent(ask({ questions: [{ ...question, options: [question.options[0]] }] }))?.askUserQuestion).toBeNull()
      expect(parseHookEvent(ask(undefined))?.askUserQuestion).toBeNull()
      expect(parseHookEvent(ask('nope'))?.askUserQuestion).toBeNull()
      expect('askUserQuestionRaw' in (parseHookEvent(ask({ questions: [] })) ?? {})).toBe(false)
      expect(parseHookEvent(ask({ questions: [question] }))?.preview).toBeUndefined()
    })
  })
})
