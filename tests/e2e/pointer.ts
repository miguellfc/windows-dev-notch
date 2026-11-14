import { expect, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'

type NotchWindow = { notch: NotchApi }

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')

/**
 * Shows the compact capsule (metrics, mail, reviews, Claude dots) as if the pointer were on it, through
 * the same IPC the capsule's pointerenter sends. Playwright's mouse is virtual: once main stops ignoring
 * the mouse, Windows can report the real cursor (somewhere else on the desktop) leaving the window, and
 * Chromium then fires a pointerleave that sends a hovered capsule back to peek mid-test. The virtual
 * mouse stays away from the capsule here, so no such leave can reach it. The real hover path (pointer
 * events, right and left clicks) is covered in app.spec.
 */
export async function showCompact(notch: Page): Promise<void> {
  await notch.mouse.move(1, 1)
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.pointer({ inside: true }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
}

/** The pointer leaves the capsule: back to peek, the resting capsule (time and date). */
export async function leaveCapsule(notch: Page): Promise<void> {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.pointer({ inside: false }))
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'peek')
}

/** Runs checks on the compact capsule, then lets the capsule rest in peek again. */
export async function whileHovered(notch: Page, check: () => Promise<void>): Promise<void> {
  await showCompact(notch)
  await check()
  await leaveCapsule(notch)
}

/**
 * A capsule block by test id, in the present copy only: a compact width change cross-fades two copies
 * of the content (the outgoing one is aria-hidden and can linger while another window has focus).
 */
export const present = (notch: Page, testId: string) =>
  notch.locator(`[data-testid="${testId}"]:not([aria-hidden="true"] *)`)
