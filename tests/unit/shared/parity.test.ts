import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { channels, eventChannels, type ChannelName, type EventName } from '../../../src/shared/ipc/channels'
import { contract, eventContract } from '../../../src/shared/ipc/contract'
import { viewIntegrationIds } from '../../../src/shared/integrations/registry'
import { messages, type MessageKey } from '../../../src/shared/i18n/messages'
import {
  CAPSULE_SIZES,
  WINDOW_WIDTH,
  capsuleTopFor,
  compactWidthFor,
  resizeOrder,
  windowBoundsFor,
  windowHeightFor,
  type Rect,
  type VisibleMode,
} from '../../../src/shared/notch/geometry'
import {
  initialNotchState,
  mailAlertShown,
  notchMode,
  redmineAlertShown,
  reduceNotch,
  reviewAlertShown,
  type ClaudeItem,
  type NotchEvent,
  type NotchState,
  type Yielding,
} from '../../../src/shared/notch/state'

/**
 * Fixtures shared with the Rust crate (`src-tauri`), generated from the TS sources of truth.
 * Each generator owns one file under `tests/parity`; `PARITY_UPDATE=1 npx vitest run parity`
 * rewrites them, otherwise the test fails when a file drifts from its source.
 */
interface ParityFixture {
  readonly file: string
  readonly source: string
  readonly build: () => unknown
  /** Single-line JSON, for the big generated files. */
  readonly compact?: boolean
}

const parityDir = resolve(__dirname, '../../parity')
const update = process.env['PARITY_UPDATE'] === '1'

const fixtures: readonly ParityFixture[] = [
  {
    file: 'channels.json',
    source: 'channels.ts',
    build: () => ({
      channels: Object.values(channels)
        .flatMap((group) => Object.values(group) as string[])
        .sort(),
      events: (Object.values(eventChannels) as string[]).sort(),
    }),
  },
  { file: 'notch-traces.json', source: 'notch/state.ts', build: buildNotchTraces, compact: true },
  { file: 'geometry.json', source: 'notch/geometry.ts', build: buildGeometry },
  { file: 'i18n-main.json', source: 'i18n/messages.ts', build: buildMainMessages },
  { file: 'unicode-classes.json', source: 'text.ts, notes/schema.ts, reminders/schema.ts, claude/hook-events.ts, claude/questions.ts', build: buildUnicodeClasses, compact: true },
]

/**
 * The code point classes the text rules use (`.trim()` and `\s`, `\p{Cc}`/`\p{Cf}`, `\p{Cf}` alone,
 * `\p{Default_Ignorable_Code_Point}`), as inclusive ranges from this runtime's regex engine; the
 * Rust tables must equal them.
 */
function buildUnicodeClasses(): unknown {
  const ranges = (matches: (char: string) => boolean): [number, number][] => {
    const out: [number, number][] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      if (!matches(String.fromCodePoint(code))) continue
      const last = out.at(-1)
      if (last && last[1] === code - 1) last[1] = code
      else out.push([code, code])
    }
    return out
  }
  return {
    whitespace: ranges((char) => char.trim() === '' && /^\s$/u.test(char)),
    controlOrFormat: ranges((char) => /^[\p{Cc}\p{Cf}]$/u.test(char)),
    format: ranges((char) => /^\p{Cf}$/u.test(char)),
    defaultIgnorable: ranges((char) => /^\p{Default_Ignorable_Code_Point}$/u.test(char)),
  }
}

/** Prefixes of the message keys the Rust crate shows itself (the tray menu and the toasts). */
const rustMessagePrefixes = ['claude.toast.', 'reminders.toast.', 'tray.'] as const

/** The texts the Rust crate needs, per language, loaded there with `include_str!`. */
function buildMainMessages(): unknown {
  const keys = (Object.keys(messages.es) as MessageKey[]).filter((key) => rustMessagePrefixes.some((prefix) => key.startsWith(prefix))).sort()
  return Object.fromEntries(
    (Object.keys(messages) as (keyof typeof messages)[]).sort().map((language) => [language, Object.fromEntries(keys.map((key) => [key, messages[language][key]]))]),
  )
}

/** Deterministic PRNG, so the traces are the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TRACE_SEED = 20261114
const TRACE_SEQUENCES = 200
const TRACE_EVENTS = 40

/** Every `NotchEvent` variant, with its payload drawn from the PRNG; each step records the state changes it caused. */
function buildNotchTraces(): unknown {
  const random = mulberry32(TRACE_SEED)
  const bool = () => random() < 0.5
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const yielding = (): Yielding => pick<Yielding>(['none', 'hidden'])
  const claude = (): ClaudeItem => pick<ClaudeItem>(['permission', 'question'])
  const makers: readonly (() => NotchEvent)[] = [
    () => ({ type: 'pointer', inside: bool() }),
    () => ({ type: 'pin-mini' }),
    () => ({ type: 'unpin-mini' }),
    () => ({ type: 'sticky-end' }),
    () => ({ type: 'expand' }),
    () => ({ type: 'show' }),
    () => ({ type: 'toggle' }),
    () => ({ type: 'dismiss' }),
    () => ({ type: 'foreground', verdict: yielding() }),
    () => ({ type: 'user-visibility', hidden: bool() }),
    () => ({ type: 'open-integration', id: pick(viewIntegrationIds) }),
    () => ({ type: 'back' }),
    () => ({ type: 'attention', on: bool() }),
    () => ({ type: 'reminders', due: bool() }),
    () => ({ type: 'mail', on: bool() }),
    () => ({ type: 'review', on: bool() }),
    () => ({ type: 'redmine', on: bool() }),
    () => ({ type: 'question', on: bool() }),
    () => ({ type: 'claude-first', kind: claude() }),
    () => ({ type: 'next' }),
    () => ({ type: 'open-pending' }),
  ]
  const sequences = Array.from({ length: TRACE_SEQUENCES }, () => {
    let state: NotchState = initialNotchState
    return Array.from({ length: TRACE_EVENTS }, () => {
      const event = pick(makers)()
      const previous = state
      state = reduceNotch(state, event)
      // Only the fields that changed: the replay applies them to the previous state (keeps the file small).
      const changes = Object.fromEntries(
        (Object.keys(state) as (keyof NotchState)[]).filter((key) => state[key] !== previous[key]).map((key) => [key, state[key]]),
      )
      return {
        event,
        changes,
        mode: notchMode(state),
        mailShown: mailAlertShown(state),
        reviewShown: reviewAlertShown(state),
        redmineShown: redmineAlertShown(state),
      }
    })
  })
  return { seed: TRACE_SEED, initial: initialNotchState, sequences }
}

const visibleModes = Object.keys(CAPSULE_SIZES) as VisibleMode[]

function buildGeometry(): unknown {
  const workAreas: readonly Rect[] = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1280, y: 0, width: 1280, height: 984 },
    { x: 1920, y: 0, width: 2560, height: 1392 },
  ]
  // {system: null | without battery | with battery} × claude × mail × reviews (0..2) × redmine × workLog.
  const systems = [null, { battery: false }, { battery: true }]
  const compactWidths = systems.flatMap((system) =>
    [false, true].flatMap((claude) =>
      [false, true].flatMap((mail) =>
        ([0, 1, 2] as const).flatMap((reviews) =>
          [false, true].flatMap((redmine) =>
            [false, true].map((workLog) => {
              const blocks = { claude, mail, reviews, redmine, workLog }
              return { system, blocks, width: compactWidthFor({ system, blocks }) }
            }),
          ),
        ),
      ),
    ),
  )
  return {
    windowWidth: WINDOW_WIDTH,
    capsuleSizes: CAPSULE_SIZES,
    capsuleTop: Object.fromEntries(visibleModes.map((mode) => [mode, capsuleTopFor(mode)])),
    windowHeight: Object.fromEntries(visibleModes.map((mode) => [mode, windowHeightFor(mode)])),
    windowBounds: visibleModes.flatMap((mode) => workAreas.map((workArea) => ({ mode, workArea, bounds: windowBoundsFor(mode, workArea) }))),
    resizeOrder: visibleModes.flatMap((from) => visibleModes.map((to) => ({ from, to, order: resizeOrder(from, to) }))),
    compactWidths,
  }
}

const serialize = (value: unknown, compact = false) => `${JSON.stringify(value, null, compact ? undefined : 2)}
`

/**
 * Hand-curated cases (never rewritten by PARITY_UPDATE) that the Rust crate checks with its serde
 * types and validators. A case without `value` stands for `undefined` (an input that was not sent).
 */
interface ContractCase {
  readonly channel: string
  readonly direction: 'input' | 'output' | 'event'
  readonly value?: unknown
  readonly accept: boolean
}

/** Channels and events whose contract the Rust crate ports; every one needs cases. */
const portedChannels = [
  'app:get-info',
  'app:get-runtime',
  'app:open-control-center',
  'app:hide-notch',
  'settings:get',
  'settings:update',
  'notch:get-mode',
  'notch:request',
  'notch:pointer',
  'notch:settled',
  'notch:open-integration',
  'notch:back',
  'notch:capsule-rect',
  'usage:summary',
  'notes:list',
  'notes:create',
  'notes:update',
  'notes:pin',
  'notes:delete',
  'notes:restore',
  'notes:copy',
  'reminders:list',
  'reminders:create',
  'reminders:update',
  'reminders:snooze',
  'reminders:complete',
  'reminders:delete',
  'apps:open',
  'claude:get-state',
  'claude:decide',
  'claude:focus-app',
  'claude:dismiss-session',
  'claude:hooks-preview',
  'claude:hooks-install',
  'claude:hooks-uninstall',
  'claude:test-connection',
  'claude:rotate-token',
  'claude:rotate-port',
  'claude:get-questions',
  'claude:answer',
  'claude:release-question',
  'claude:accounts',
  'claude:account-add',
  'code-review:get-state',
  'code-review:refresh',
  'code-review:open-profile',
  'code-review:open-alert',
  'code-review:set-token',
  'code-review:clear',
  'code-review:view',
  'code-review:contributions',
  'redmine:get-state',
  'redmine:issues',
  'redmine:issue',
  'redmine:find-issue',
  'redmine:activities',
  'redmine:update-issue',
  'redmine:log-time',
  'redmine:summary',
  'redmine:view',
  'redmine:refresh',
  'redmine:open',
  'redmine:set-key',
  'redmine:clear',
  'work-log:list',
  'work-log:set-invoiced',
  'work-log:delete',
  'work-log:restore',
  'work-log:copy',
  'work-log:summarize',
  'work-log:claude-available',
  'gmail:get-state',
  'gmail:recent',
  'gmail:view',
  'gmail:refresh',
  'gmail:open',
  'gmail:message',
  'gmail:mark-read',
  'gmail:delete',
  'gmail:open-link',
  'gmail:close-message',
  'gmail:sign-in',
  'gmail:cancel-sign-in',
  'gmail:sign-out',
  'gmail:pick-client-file',
] as const satisfies readonly ChannelName[]
const portedEvents = [
  'notch:mode-changed',
  'notch:mail-alert',
  'notch:review-alert',
  'notch:redmine-alert',
  'settings:changed',
  'system:metrics',
  'notes:changed',
  'reminders:changed',
  'reminders:fired',
  'claude:state-changed',
  'claude:questions',
  'code-review:state',
  'code-review:alert',
  'code-review:contributions-changed',
  'redmine:state',
  'redmine:summary-changed',
  'redmine:alert',
  'work-log:changed',
  'gmail:state',
  'gmail:new-mail',
] as const satisfies readonly EventName[]

const contractCases = JSON.parse(readFileSync(resolve(parityDir, 'contract-cases.json'), 'utf8')) as ContractCase[]

function schemaOf(testCase: ContractCase): z.ZodType {
  if (testCase.direction === 'event') {
    const schema = (eventContract as Record<string, z.ZodType | undefined>)[testCase.channel]
    if (!schema) throw new Error(`Unknown event ${testCase.channel}`)
    return schema
  }
  const entry = (contract as Record<string, { input: z.ZodType; output: z.ZodType } | undefined>)[testCase.channel]
  if (!entry) throw new Error(`Unknown channel ${testCase.channel}`)
  return entry[testCase.direction]
}

describe('contract cases', () => {
  it('cover every ported channel and event in both verdicts', () => {
    expect(contractCases.length).toBeGreaterThanOrEqual(60)
    const verdicts = (channel: string, direction: ContractCase['direction']) =>
      new Set(contractCases.filter((c) => c.channel === channel && c.direction === direction).map((c) => c.accept))
    for (const channel of portedChannels) {
      expect(verdicts(channel, 'input'), `${channel} input`).toEqual(new Set([true, false]))
      expect(verdicts(channel, 'output'), `${channel} output`).toEqual(new Set([true, false]))
    }
    for (const event of portedEvents) {
      expect(verdicts(event, 'event'), event).toEqual(new Set([true, false]))
    }
    const ported = new Set<string>([...portedChannels, ...portedEvents])
    expect(contractCases.filter((c) => !ported.has(c.channel))).toEqual([])
  })

  it('every contract case gets the expected zod verdict', () => {
    const mismatches = contractCases
      .map((testCase, index) => ({ index, testCase, accepted: schemaOf(testCase).safeParse(testCase.value).success }))
      .filter(({ testCase, accepted }) => accepted !== testCase.accept)
      .map(({ index, testCase }) => `#${index} ${testCase.channel} ${testCase.direction}: expected accept=${testCase.accept}`)
    expect(mismatches).toEqual([])
  })
})

describe('parity fixtures', () => {
  for (const fixture of fixtures) {
    it(`${fixture.file} matches ${fixture.source}`, () => {
      const path = resolve(parityDir, fixture.file)
      const expected = serialize(fixture.build(), fixture.compact)
      if (update) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, expected)
      }
      // Normalise line endings so a CRLF checkout does not count as drift.
      expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).toBe(expected)
    })
  }
})
