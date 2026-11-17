// WebdriverIO runner for the Tauri app (docs/e2e.md). `npm run test:e2e` builds the
// debug binary with the `e2e` feature first; this file starts tauri-driver (over msedgedriver),
// which launches that binary for every WebDriver session.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import type { Capabilities, Options } from '@wdio/types'
import { SevereServiceError } from 'webdriverio'

const root = resolve(import.meta.dirname, '../..')
// Another `e2e` build (a release one, say) can be given with NOTCH_E2E_APP.
const application = process.env['NOTCH_E2E_APP'] ?? join(root, 'src-tauri/target/debug/developer-notch.exe')
// The specs relaunch the app with their own arguments (helpers.ts `launch`); workers inherit this.
process.env['NOTCH_E2E_APP'] = application
const tauriDriverPath = process.env['TAURI_DRIVER'] ?? join(homedir(), '.cargo/bin/tauri-driver.exe')
const nativeDriverPath =
  process.env['NOTCH_MSEDGEDRIVER'] ?? join(process.env['LOCALAPPDATA'] ?? '', 'Programs/msedgedriver/msedgedriver.exe')
// Away from the defaults (4444 / 9515) so nothing else listening there is reused.
const DRIVER_PORT = 4746
const NATIVE_PORT = 9746

// One profile per run, shared by the launcher and its workers (they inherit the environment); the
// specs empty it before each test. tauri-driver passes its environment on to every app it starts.
// Created in `onPrepare` (the launcher only), not when a worker imports this file; a directory the
// caller supplies through NOTCH_E2E_DATA_DIR is used as is and never deleted.
let createdDataDir: string | undefined

function appEnv(dataDir: string): Record<string, string> {
  return {
    NOTCH_USER_DATA_DIR: dataDir,
    // The capsule must not depend on whatever window is in front, nor on the user's real cursor.
    NOTCH_DISABLE_FOREGROUND_WATCH: '1',
    NOTCH_DISABLE_CURSOR_POLL: '1',
    NOTCH_TEST_CLOCK: '1',
    // Defence in depth: launches are recorded, never executed, in every session, so no spec can
    // open Claude Desktop, a browser or a terminal for real (apps.spec also sets it per launch).
    NOTCH_APP_LAUNCH_LOG: '1',
    // Claude Code: never the user's ~/.claude/settings.json, never a fixed port an installed notch
    // may hold, never the user's real Claude window brought forward. The Claude specs pass the same
    // switches per launch too (helpers.ts `claudeEnv`).
    NOTCH_CLAUDE_SETTINGS: join(dataDir, 'claude-settings.json'),
    NOTCH_CLAUDE_PORT: '0',
    NOTCH_DISABLE_CLAUDE_FOCUS: '1',
    // Code review: no app of the run may reach the real GitHub or GitLab, nor open a browser. Both
    // platforms point at a closed loopback port (the discard port, nothing listens there) unless a
    // spec passes its fake server per launch; URLs to open are recorded, never opened.
    NOTCH_CODE_REVIEW_BASE_URLS: 'github=http://127.0.0.1:9,gitlab=http://127.0.0.1:9',
    // Redmine: likewise, the API points at the closed loopback port unless redmine.spec passes its
    // fake server per launch; no app of the run can reach a real Redmine.
    NOTCH_REDMINE_BASE_URL: 'http://127.0.0.1:9',
    // Gmail: Google (consent screen, token, revoke and the Gmail API) points at the closed loopback
    // port unless gmail.spec passes its fake server per launch; no app of the run can reach Google.
    NOTCH_GMAIL_BASE_URL: 'http://127.0.0.1:9',
    // The client-file picker answers this path instead of opening the real dialog. It does not
    // exist, so a stray "Cargar archivo JSON" answers "Not a Google desktop client file" (the picker stats
    // it first and refuses what it cannot read) and never opens a dialog. gmail.spec passes a real
    // file per launch; a per-launch switch msedgedriver dropped would fall back to this path. Never
    // the empty value here or per launch: the picker reads it as Cancel.
    NOTCH_GMAIL_CLIENT_FILE: join(dataDir, 'no-such-gmail-client-file.json'),
    NOTCH_OPEN_URL_LOG: '1',
  }
}

/** Whether something accepts TCP connections on `port` (127.0.0.1). */
function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', () => done(false))
  })
}

/** Resolves once tauri-driver listens on DRIVER_PORT; rejects if it fails to start or exits first. */
async function waitForDriver(driver: ChildProcess, timeoutMs = 15_000): Promise<void> {
  let failure: Error | undefined
  driver.once('error', (error) => {
    failure = new Error(`tauri-driver could not start (${tauriDriverPath}): ${error.message}`)
  })
  driver.once('exit', (code) => {
    failure ??= new Error(
      `tauri-driver exited (code ${code}) before listening on port ${DRIVER_PORT}; is port ${DRIVER_PORT} or ${NATIVE_PORT} taken?`,
    )
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (failure) throw failure
    if (await portOpen(DRIVER_PORT)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw failure ?? new Error(`tauri-driver did not listen on port ${DRIVER_PORT} within ${timeoutMs} ms`)
}

let tauriDriver: ChildProcess | undefined

type TauriCapabilities = Capabilities.RequestedStandaloneCapabilities & { 'tauri:options': { application: string } }

export const config: Options.Testrunner & { capabilities: TauriCapabilities[] } = {
  runner: 'local',
  specs: ['./app.spec.ts', './system.spec.ts', './system-alerts.spec.ts', './notes.spec.ts', './reminders.spec.ts', './apps.spec.ts', './claude.spec.ts', './claude-questions.spec.ts', './code-review.spec.ts', './redmine.spec.ts', './gmail.spec.ts'],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: DRIVER_PORT,
  capabilities: [{ 'tauri:options': { application } }],
  logLevel: 'warn',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 180_000 },

  async onPrepare() {
    try {
      await startDriver()
    } catch (error) {
      cleanUp()
      // Severe: wdio stops the run here instead of starting workers against a missing driver.
      throw new SevereServiceError(error instanceof Error ? error.message : String(error))
    }
  },

  onComplete() {
    cleanUp()
  },
}

async function startDriver(): Promise<void> {
  for (const [what, path] of [
    ['app (run npm run test:e2e:tauri)', application],
    ['tauri-driver', tauriDriverPath],
    ['msedgedriver', nativeDriverPath],
  ] as const) {
    if (!existsSync(path)) throw new Error(`Missing ${what}: ${path} (see docs/e2e.md)`)
  }
  if (await portOpen(DRIVER_PORT)) {
    throw new Error(`Port ${DRIVER_PORT} is already in use: stop whatever listens there (an earlier tauri-driver?)`)
  }
  if (!process.env['NOTCH_E2E_DATA_DIR']) {
    createdDataDir = mkdtempSync(join(tmpdir(), 'notch-tauri-e2e-'))
    process.env['NOTCH_E2E_DATA_DIR'] = createdDataDir
  }
  tauriDriver = spawn(
    tauriDriverPath,
    ['--port', String(DRIVER_PORT), '--native-port', String(NATIVE_PORT), '--native-driver', nativeDriverPath],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...appEnv(process.env['NOTCH_E2E_DATA_DIR']) } },
  )
  await waitForDriver(tauriDriver)
}

function cleanUp(): void {
  // Only the process tree this run started (tauri-driver and its msedgedriver).
  if (tauriDriver?.pid !== undefined && tauriDriver.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(tauriDriver.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  // Only a directory this run created; a caller-supplied NOTCH_E2E_DATA_DIR is left alone.
  if (createdDataDir) rmSync(createdDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  createdDataDir = undefined
}
