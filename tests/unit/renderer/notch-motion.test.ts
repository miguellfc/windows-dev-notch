import { describe, expect, it } from 'vitest'
import {
  capsuleRadius,
  CONTENT_EXIT,
  CONTENT_ENTER,
  GROW_CAPSULE,
  GROW_PANEL,
  morphTransition,
  PANEL_STAGGER,
  SHRINK,
} from '../../../src/renderer/notch/motion'
import { CAPSULE_SIZES, type VisibleMode } from '../../../src/shared/notch/geometry'
import { PANEL_MODES } from '../../../src/shared/notch/state'

const MODES = Object.keys(CAPSULE_SIZES) as VisibleMode[]

describe('notch morph transitions', () => {
  it('opens the panel views with the panel spring and every small capsule with the short one', () => {
    for (const mode of MODES) {
      expect(morphTransition(mode, true)).toBe(PANEL_MODES.has(mode) ? GROW_PANEL : GROW_CAPSULE)
    }
  })

  it('closes with the same quick curve whatever the target', () => {
    for (const mode of MODES) expect(morphTransition(mode, false)).toBe(SHRINK)
  })

  it('always opens slower than it closes', () => {
    for (const grow of [GROW_PANEL, GROW_CAPSULE]) expect(grow.visualDuration).toBeGreaterThan(SHRINK.duration)
    expect(GROW_PANEL.visualDuration).toBeGreaterThan(GROW_CAPSULE.visualDuration)
  })

  it('never overshoots on the small capsules (alerts included) and only subtly on the panel', () => {
    expect(GROW_CAPSULE.bounce).toBe(0)
    expect(GROW_PANEL.bounce).toBeGreaterThan(0)
    expect(GROW_PANEL.bounce).toBeLessThanOrEqual(0.1)
  })
})

describe('content cross-fade', () => {
  it('lets the old content leave faster than the new one arrives', () => {
    expect(CONTENT_EXIT.duration).toBeLessThan(CONTENT_ENTER.duration)
  })

  it('starts the new content only once the old one is mostly gone (no double exposure)', () => {
    // The ease-out exit has covered well over half its fade by the time the entry starts.
    expect(CONTENT_ENTER.delay).toBeGreaterThanOrEqual(CONTENT_EXIT.duration / 2)
    expect(CONTENT_ENTER.delay).toBeLessThan(CONTENT_EXIT.duration)
  })

  it('has the new content fully in before the panel morph ends', () => {
    expect(CONTENT_ENTER.delay + CONTENT_ENTER.duration).toBeLessThanOrEqual(GROW_PANEL.visualDuration)
  })

  it('staggers the panel sections 30 ms apart', () => {
    expect(PANEL_STAGGER.shown.transition.staggerChildren).toBe(0.03)
  })
})

describe('capsuleRadius', () => {
  it('rounds the panel views at 24 px and the capsules as true pills (half their height)', () => {
    for (const mode of MODES) {
      expect(capsuleRadius(mode)).toBe(PANEL_MODES.has(mode) ? 24 : CAPSULE_SIZES[mode].height / 2)
    }
  })

  it('never exceeds half the capsule height, so the morph never flashes an ellipse', () => {
    for (const mode of MODES) expect(capsuleRadius(mode)).toBeLessThanOrEqual(CAPSULE_SIZES[mode].height / 2)
  })
})
