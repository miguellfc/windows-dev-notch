// Plain data on purpose (no `motion/react` types): the unit tests import this file under the
// Node tsconfig, where Motion's DOM-typed declarations would not resolve. Each value is
// checked against Motion's types where NotchApp passes it in.
import { CAPSULE_SIZES, type VisibleMode } from '../../shared/notch/geometry'
import { PANEL_MODES } from '../../shared/notch/state'

/** Strong ease-out for UI (DESIGN.md motion). */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const

// One authored motion: the capsule morphs as a single object. Opening springs, closing is quicker.
/** Capsule → panel (expanded, terminal, reminders, permission): a large object, subtle bounce. */
export const GROW_PANEL = { type: 'spring', visualDuration: 0.32, bounce: 0.1 } as const
/** Small growths (compact on hover, alert, peek, mini): short and without overshoot. */
export const GROW_CAPSULE = { type: 'spring', visualDuration: 0.22, bounce: 0 } as const
/** Every shrink. Shorter than either growth so closing always reads faster than opening. */
export const SHRINK = { duration: 0.2, ease: EASE_OUT } as const

export type MorphTransition = typeof GROW_PANEL | typeof GROW_CAPSULE | typeof SHRINK

/** Morph for a change into `mode`; `growing` compares capsule areas. */
export function morphTransition(mode: VisibleMode, growing: boolean): MorphTransition {
  if (!growing) return SHRINK
  return PANEL_MODES.has(mode) ? GROW_PANEL : GROW_CAPSULE
}

/** Panel corner radius, or a true pill (half the height) for the capsule shapes. */
export function capsuleRadius(mode: VisibleMode): number {
  return PANEL_MODES.has(mode) ? 24 : CAPSULE_SIZES[mode].height / 2
}

/**
 * Levitation (DESIGN.md "Shadow Vocabulary"), single source. The drop shadow is a
 * `filter: drop-shadow()` on an unscaled wrapper, so it follows the capsule's visual shape with
 * a constant blur: as a `box-shadow` on the morphing capsule, Motion could only correct it by
 * the average scale, and the non-uniform scale of a morph stretched it (a tall blob on close).
 * The 1 px top highlight stays an inset `box-shadow` on the capsule.
 */
export const LEVITATION_DROP = 'drop-shadow(0 18px 50px rgba(0,0,0,0.55))'
export const LEVITATION_LOW_DROP = 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))'
export const LEVITATION_EDGE = 'inset 0 1px 0 rgba(255,255,255,0.06)'

/**
 * Content cross-fade: out quickly, in once the old content is nearly gone (no double exposure).
 * The 60 ms wait applies both ways: without it, closing showed both texts at ~50 % opacity
 * around 30 ms in (measured), which reads as a smear on a 36 px capsule.
 */
/** Content is projected from the capsule's top-centre during the morph (Motion `layoutAnchor`). */
export const CONTENT_ANCHOR = { x: 0.5, y: 0 } as const

export const CONTENT_EXIT = { duration: 0.09, ease: 'easeOut' } as const
export const CONTENT_ENTER = { duration: 0.18, ease: EASE_OUT, delay: 0.06 } as const

/** Panel sections enter 30 ms apart; opacity and a 4 px rise only, so they stay clickable throughout. */
export const PANEL_STAGGER = { hidden: {}, shown: { transition: { staggerChildren: 0.03 } } } as const
export const PANEL_ITEM = {
  hidden: { opacity: 0, y: 4 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE_OUT } },
} as const
