/**
 * How long Close ignores activation after the confirm question opens. A double click on ✕ must
 * never confirm with its second click, whatever ends up under the pointer.
 */
export const CONFIRM_ARM_MS = 300

/** Whether Close may act, given when the question opened and the current time (ms). */
export function confirmArmed(openedAt: number, now: number, delay = CONFIRM_ARM_MS): boolean {
  return now - openedAt >= delay
}
