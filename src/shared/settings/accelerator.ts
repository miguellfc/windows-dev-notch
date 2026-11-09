/** The parts of a KeyboardEvent needed to build a shortcut. */
export interface KeyInput {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
}

export type AcceleratorResult =
  | { kind: 'ok'; accelerator: string }
  | { kind: 'incomplete' }
  | { kind: 'needs-modifier' }
  | { kind: 'unsupported' }

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

/** Maps a physical key (KeyboardEvent.code) to an Electron accelerator key, or null if unsupported. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1] ?? null
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1] ?? null
  // Electron names keypad digits num0–num9; they are different keys from the top row.
  const keypad = /^Numpad(\d)$/.exec(code)
  if (keypad) return `num${keypad[1] ?? ''}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code] ?? null
}

/** Turns a key press into an Electron accelerator such as `Control+Alt+Space`. */
export function acceleratorFromKey(input: KeyInput): AcceleratorResult {
  if (MODIFIER_CODES.test(input.code)) return { kind: 'incomplete' }
  if (!input.ctrlKey && !input.altKey && !input.metaKey) return { kind: 'needs-modifier' }
  const key = keyName(input.code)
  if (!key) return { kind: 'unsupported' }
  const parts = [
    input.ctrlKey && 'Control',
    input.altKey && 'Alt',
    input.shiftKey && 'Shift',
    input.metaKey && 'Super',
    key,
  ].filter((part): part is string => Boolean(part))
  return { kind: 'ok', accelerator: parts.join('+') }
}

const REQUIRED_MODIFIERS = new Set(['Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Super', 'Meta'])
const ALL_MODIFIERS = new Set([...REQUIRED_MODIFIERS, 'Shift'])

/**
 * A global shortcut must include Ctrl, Alt or Win and end in a real key; otherwise it
 * would steal a plain key (or Shift+key) from every application.
 */
export function isSafeAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+')
  const last = parts.at(-1)
  return (
    last !== undefined && !ALL_MODIFIERS.has(last) && parts.slice(0, -1).some((part) => REQUIRED_MODIFIERS.has(part))
  )
}

const DISPLAY: Readonly<Record<string, string>> = {
  Control: 'Ctrl',
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Super: 'Win',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
}

/** Splits an accelerator into the key labels a person reads on their keyboard. */
export function formatAccelerator(accelerator: string): string[] {
  return accelerator.split('+').map((part) => DISPLAY[part] ?? part)
}
