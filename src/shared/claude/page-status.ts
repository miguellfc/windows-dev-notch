import type { MessageKey } from '../i18n/messages'
import type { ClaudeRotateOutcome, ClaudeState } from './types'

export type StatusTone = 'ok' | 'wait' | 'fail' | 'neutral'
export type StatusIcon = 'check' | 'clock' | 'alert' | 'minus' | 'help'

export interface StatusView {
  label: MessageKey
  icon: StatusIcon
  tone: StatusTone
}

const CONNECTION: Record<ClaudeState['connection'], StatusView> = {
  connected: { label: 'cc.claude.connection.connected', icon: 'check', tone: 'ok' },
  'waiting-for-events': { label: 'cc.claude.connection.waiting', icon: 'clock', tone: 'wait' },
  'not-installed': { label: 'cc.claude.connection.notInstalled', icon: 'minus', tone: 'neutral' },
  error: { label: 'cc.claude.connection.error', icon: 'alert', tone: 'fail' },
}

const HOOKS: Record<ClaudeState['hooks'], StatusView> = {
  installed: { label: 'cc.claude.hooks.installed', icon: 'check', tone: 'ok' },
  outdated: { label: 'cc.claude.hooks.outdated', icon: 'alert', tone: 'wait' },
  missing: { label: 'cc.claude.hooks.missing', icon: 'minus', tone: 'neutral' },
  unknown: { label: 'cc.claude.hooks.unknown', icon: 'help', tone: 'wait' },
}

export const connectionView = (connection: ClaudeState['connection']): StatusView => CONNECTION[connection]
export const hooksView = (hooks: ClaudeState['hooks']): StatusView => HOOKS[hooks]

/** Another program holds our port: it could receive Claude's permission requests. */
export const portInUse = (state: ClaudeState): boolean => state.connection === 'error' && state.reason === 'port-in-use'

export interface RotateNotice {
  tone: 'info' | 'error'
  key: MessageKey
}

/** Result line after rotating the token or the port; a failed hook reinstall is an error, not a success. */
export const rotateNotice = (what: 'token' | 'port', outcome: ClaudeRotateOutcome): RotateNotice => {
  const failed = outcome.hooks === 'reinstall-failed'
  if (what === 'token') return failed ? { tone: 'error', key: 'cc.claude.rotatedReinstallFailed' } : { tone: 'info', key: 'cc.claude.rotated' }
  return failed ? { tone: 'error', key: 'cc.claude.portChangedReinstallFailed' } : { tone: 'info', key: 'cc.claude.portChanged' }
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'same'
  text: string
}

/** Leading marker so a diff line never relies on colour alone. */
export const diffMarker = (kind: DiffLine['kind']): string => (kind === 'add' ? '+' : kind === 'remove' ? '−' : ' ')
