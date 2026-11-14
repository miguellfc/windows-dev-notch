import type { ITheme } from '@xterm/xterm'

/**
 * Obsidian (DESIGN.md) for xterm: Obsidiana Densa background, Tiza text, Azul Hielo caret and
 * selection. The ANSI palette is cooled down to sit next to the status tokens; programs pick
 * these colours, not us, so they are tuned for legibility on #0E0E10 rather than meaning.
 */
export const obsidianTerminalTheme: ITheme = {
  background: '#0e0e10',
  foreground: '#ededef',
  cursor: '#7dd3fc',
  cursorAccent: '#06202b',
  selectionBackground: 'rgba(125, 211, 252, 0.28)',
  selectionForeground: '#ededef',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.08)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.14)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.18)',
  black: '#1c1c20',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c4a1f5',
  cyan: '#7dd3fc',
  white: '#d4d4d8',
  brightBlack: '#8b8b93',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#dcc6fb',
  brightCyan: '#bae6fd',
  brightWhite: '#ededef',
}
