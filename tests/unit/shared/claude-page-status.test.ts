import { describe, expect, it } from 'vitest'
import { connectionView, diffMarker, hooksView, portInUse, rotateNotice } from '../../../src/shared/claude/page-status'
import type { ClaudeState } from '../../../src/shared/claude/types'

describe('claude page status', () => {
  it('maps every connection to a text key and an icon', () => {
    expect(connectionView('connected')).toMatchObject({ icon: 'check', tone: 'ok' })
    expect(connectionView('error')).toMatchObject({ icon: 'alert', tone: 'fail' })
    expect(connectionView('not-installed').label).toBe('cc.claude.connection.notInstalled')
  })

  it('covers outdated and unknown hooks with their own text', () => {
    expect(hooksView('outdated').label).toBe('cc.claude.hooks.outdated')
    expect(hooksView('unknown').label).toBe('cc.claude.hooks.unknown')
  })

  it('flags port-in-use only for an error with that reason', () => {
    const base: ClaudeState = { connection: 'error', hooks: 'installed', sessions: [], pending: [] }
    expect(portInUse({ ...base, reason: 'port-in-use' })).toBe(true)
    expect(portInUse(base)).toBe(false)
    expect(portInUse({ ...base, connection: 'connected', reason: 'port-in-use' })).toBe(false)
  })

  it('reports a failed reinstall after a rotation as an error, never as plain success', () => {
    expect(rotateNotice('token', { hooks: 'reinstalled' })).toEqual({ tone: 'info', key: 'cc.claude.rotated' })
    expect(rotateNotice('token', { hooks: 'not-installed' })).toEqual({ tone: 'info', key: 'cc.claude.rotated' })
    expect(rotateNotice('token', { hooks: 'reinstall-failed' })).toEqual({ tone: 'error', key: 'cc.claude.rotatedReinstallFailed' })
    expect(rotateNotice('port', { hooks: 'reinstalled' })).toEqual({ tone: 'info', key: 'cc.claude.portChanged' })
    expect(rotateNotice('port', { hooks: 'reinstall-failed' })).toEqual({ tone: 'error', key: 'cc.claude.portChangedReinstallFailed' })
  })

  it('marks diff lines without colour', () => {
    expect(diffMarker('add')).toBe('+')
    expect(diffMarker('remove')).toBe('−')
    expect(diffMarker('same')).toBe(' ')
  })
})
