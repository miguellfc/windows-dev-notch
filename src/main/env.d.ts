/// <reference types="electron-vite/node" />

/**
 * Dev/test-only clock control (`NOTCH_TEST_CLOCK=1`, never in a packaged build): E2E tests move
 * the reminders and Gmail clock forward (due Gmail polls fire) and wait for the reminders check.
 */
// eslint-disable-next-line no-var -- only `var` adds a typed property to globalThis
declare var __notchTestClock: { advance(ms: number): Promise<void> } | undefined
