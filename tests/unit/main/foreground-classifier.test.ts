import { describe, expect, it } from 'vitest'
import { classifyForeground, type ForegroundSnapshot } from '../../../src/main/platform/foreground-classifier'

const monitor = { left: 0, top: 0, right: 1920, bottom: 1080 }
const other = { left: 1920, top: 0, right: 4480, bottom: 1440 }

const snap = (overrides: Partial<ForegroundSnapshot> = {}): ForegroundSnapshot => ({
  handle: '100',
  className: 'Chrome_WidgetWin_1',
  zoomed: false,
  coversMonitor: false,
  monitor,
  notificationState: 'normal',
  ...overrides,
})

const classify = (s: ForegroundSnapshot) => classifyForeground(s, { ownHandles: ['999'], notchMonitor: monitor })

describe('classifyForeground', () => {
  it('lets the capsule stay normal for ordinary windows', () => {
    expect(classify(snap())).toBe('none')
  })

  it('shrinks to mini over a maximized window', () => {
    expect(classify(snap({ zoomed: true }))).toBe('mini')
  })

  it('hides for a window covering the monitor, even before Windows reports it (M0)', () => {
    expect(classify(snap({ coversMonitor: true }))).toBe('hidden')
  })

  it('hides when Windows reports fullscreen, presentation or D3D', () => {
    for (const notificationState of ['busy', 'presentation', 'd3d', 'app'] as const) {
      expect(classify(snap({ notificationState })), notificationState).toBe('hidden')
    }
  })

  it('returns to normal when the desktop is focused', () => {
    expect(classify(snap({ className: 'Progman', coversMonitor: true }))).toBe('none')
    expect(classify(snap({ className: 'WorkerW' }))).toBe('none')
  })

  it('keeps the previous verdict for its own windows, the taskbar and unknown windows', () => {
    expect(classify(snap({ handle: '999' }))).toBe('keep')
    expect(classify(snap({ className: 'Shell_TrayWnd' }))).toBe('keep')
    expect(classify(snap({ handle: null }))).toBe('keep')
  })

  it('ignores maximized or fullscreen windows on another monitor', () => {
    expect(classify(snap({ zoomed: true, monitor: other }))).toBe('none')
    expect(classify(snap({ coversMonitor: true, monitor: other }))).toBe('none')
  })

  it('still respects a system-wide presentation mode on another monitor', () => {
    expect(classify(snap({ notificationState: 'presentation', monitor: other }))).toBe('hidden')
  })
})
