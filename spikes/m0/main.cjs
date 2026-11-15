// THROWAWAY M0 spike. Answers: adaptive transparent window + morph, click-through,
// fullscreen/maximized detection, Claude hooks over HTTP, focus, bringing Claude to front, DPI.
const { app, BrowserWindow, globalShortcut, screen, ipcMain } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const win32 = require('./win32.cjs')

const LOG_DIR = path.join(__dirname, 'logs')
const FIXTURE_DIR = path.join(__dirname, 'fixtures')
fs.mkdirSync(LOG_DIR, { recursive: true })
fs.mkdirSync(FIXTURE_DIR, { recursive: true })

function log(kind, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), kind, ...data })
  fs.appendFileSync(path.join(LOG_DIR, 'spike.log'), `${line}\n`)
  console.log(line)
}

// Capsule sizes (DIP) and the transparent room around it for the CSS shadow.
const SIZES = { compact: { w: 220, h: 36 }, expanded: { w: 440, h: 300 }, mini: { w: 120, h: 6 } }
const MARGIN = { side: 32, top: 6, bottom: 48 }
const BRIDGE_PORT = 47821
const BRIDGE_TOKEN = 'm0-spike-local-token'

let win
let state = 'compact'
let yielded = 'normal' // normal | mini | hidden (from the foreground watcher)
let currentDisplay
let previousForeground = null
let pendingShrink = null

const ownAddress = () => {
  if (!win) return null
  const handle = win.getNativeWindowHandle()
  return handle.readBigUInt64LE(0).toString()
}

function boundsFor(name, display) {
  const { w, h } = SIZES[name]
  const width = w + MARGIN.side * 2
  const height = MARGIN.top + h + MARGIN.bottom
  const area = display.bounds
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height }
}

function area(name) {
  return SIZES[name].w * SIZES[name].h
}

/** Strategy A: grow the window first then animate; animate first then shrink the window. */
function setState(next, reason) {
  if (next === state && !pendingShrink) return
  const from = state
  state = next
  const target = boundsFor(next, currentDisplay)
  const started = performance.now()
  if (area(next) >= area(from)) {
    win.setBounds(target)
    win.webContents.send('state', next)
    log('morph', { from, to: next, reason, order: 'resize-then-animate', setBoundsMs: +(performance.now() - started).toFixed(1), bounds: target })
  } else {
    pendingShrink = { target, from, next, started }
    win.webContents.send('state', next)
  }
}

ipcMain.on('settled', () => {
  if (!pendingShrink) return
  const { target, from, next, started } = pendingShrink
  pendingShrink = null
  win.setBounds(target)
  log('morph', { from, to: next, order: 'animate-then-resize', totalMs: +(performance.now() - started).toFixed(1), bounds: target })
})

ipcMain.on('hover', (_e, inside) => {
  win.setIgnoreMouseEvents(!inside, { forward: true })
})

ipcMain.on('request', (_e, next) => {
  if (next === 'expanded') expand('click')
  else collapse('escape-or-click-away')
})

ipcMain.on('focus-claude', () => focusClaude('panel-button'))

function expand(reason) {
  previousForeground = win32.fn.GetForegroundWindow()
  const before = win32.describe(previousForeground)
  win.showInactive()
  win.focus()
  setState('expanded', reason)
  setTimeout(() => {
    const now = win32.describe(win32.fn.GetForegroundWindow())
    log('focus-on-expand', { reason, before: before && { exe: before.exe, title: before.title }, gotFocus: now?.address === ownAddress(), now: now && { exe: now.exe, title: now.title } })
  }, 150)
}

function collapse(reason) {
  setState(yielded === 'mini' ? 'mini' : 'compact', reason)
  win.blur()
  setTimeout(() => {
    let now = win32.describe(win32.fn.GetForegroundWindow())
    const prev = previousForeground && win32.describe(previousForeground)
    const restoredByBlur = !!prev && now?.address === prev.address
    let restoredBySetForeground = null
    if (!restoredByBlur && previousForeground) {
      restoredBySetForeground = win32.bringToFront(previousForeground, { altTrick: false })
      now = win32.describe(win32.fn.GetForegroundWindow())
    }
    log('focus-on-collapse', { reason, previous: prev && { exe: prev.exe, title: prev.title }, restoredByBlur, restoredBySetForeground, now: now && { exe: now.exe, title: now.title } })
  }, 150)
}

function focusClaude(reason) {
  const windows = win32.topLevelWindowsOf('claude.exe')
  if (windows.length === 0) {
    log('focus-claude', { reason, found: 0 })
    return
  }
  const target = windows[0]
  const plain = win32.bringToFront(target.hwnd, { altTrick: false })
  const withAlt = plain.isNowForeground ? null : win32.bringToFront(target.hwnd, { altTrick: true })
  log('focus-claude', { reason, found: windows.length, titles: windows.map((w) => w.title), plain, withAlt })
}

function moveToDisplay(display, reason) {
  currentDisplay = display
  win.setBounds(boundsFor(state, display))
  log('display', { reason, id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor })
}

function startForegroundWatcher() {
  let last = ''
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()
  let samples = 0
  let totalMs = 0
  setInterval(() => {
    const t0 = performance.now()
    const snap = win32.foregroundSnapshot([ownAddress()])
    totalMs += performance.now() - t0
    samples += 1
    if (snap.verdict === 'ignore') return
    const key = `${snap.verdict}|${snap.quns}|${snap.window?.address}`
    if (key !== last) {
      last = key
      log('foreground', {
        verdict: snap.verdict,
        quns: snap.quns,
        exe: snap.window?.exe,
        title: snap.window?.title?.slice(0, 80),
        className: snap.window?.className,
        zoomed: snap.window?.zoomed,
        coversMonitor: snap.window?.coversMonitor,
      })
      applyYield(snap.verdict)
    }
  }, 500)
  setInterval(() => {
    const cpu = process.cpuUsage(cpuStart)
    const wall = performance.now() - wallStart
    log('watcher-cost', {
      samples,
      avgPollMs: +(totalMs / samples).toFixed(3),
      mainProcessCpuPercent: +(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(2),
    })
  }, 30_000)
}

function applyYield(verdict) {
  if (verdict === yielded || state === 'expanded') {
    yielded = verdict
    return
  }
  yielded = verdict
  if (verdict === 'hidden') win.hide()
  else {
    if (!win.isVisible()) win.showInactive()
    setState(verdict === 'mini' ? 'mini' : 'compact', `foreground:${verdict}`)
  }
}

function startBridge() {
  const server = http.createServer((req, res) => {
    const receivedAt = new Date().toISOString()
    if (req.method !== 'POST' || req.url !== '/hook' || req.headers['x-notch-token'] !== BRIDGE_TOKEN) {
      log('bridge-rejected', { method: req.method, url: req.url, hasToken: Boolean(req.headers['x-notch-token']) })
      res.writeHead(403).end()
      return
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        // keep raw only
      }
      const event = body?.hook_event_name ?? 'unknown'
      fs.writeFileSync(path.join(FIXTURE_DIR, `${Date.now()}-${event}.json`), raw)
      log('hook', {
        receivedAt,
        event,
        session: typeof body?.session_id === 'string' ? body.session_id.slice(0, 8) : null,
        notificationType: body?.notification_type ?? null,
        keys: body ? Object.keys(body).sort() : null,
        userAgent: req.headers['user-agent'] ?? null,
      })
      win?.webContents.send('hook', { event, notificationType: body?.notification_type ?? null })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  server.listen(BRIDGE_PORT, '127.0.0.1', () => log('bridge-listening', { port: BRIDGE_PORT }))
}

app.whenReady().then(() => {
  log('displays', {
    all: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })),
  })
  currentDisplay = screen.getPrimaryDisplay()

  win = new BrowserWindow({
    ...boundsFor('compact', currentDisplay),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, 'capsule.html'))
  win.once('ready-to-show', () => {
    win.showInactive()
    log('window-ready', { bounds: win.getBounds(), own: ownAddress() })
  })

  globalShortcut.register('Control+Alt+Space', () => {
    if (state === 'expanded') return collapse('shortcut')
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (cursorDisplay.id !== currentDisplay.id) moveToDisplay(cursorDisplay, 'shortcut-follows-cursor')
    expand('shortcut')
  })
  globalShortcut.register('Control+Alt+K', () => focusClaude('shortcut'))
  log('shortcuts', { 'Control+Alt+Space': globalShortcut.isRegistered('Control+Alt+Space'), 'Control+Alt+K': globalShortcut.isRegistered('Control+Alt+K') })

  for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(evt, (_e, display, changed) => {
      log('display-event', { evt, id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds, changed })
      const stillThere = screen.getAllDisplays().find((d) => d.id === currentDisplay.id)
      moveToDisplay(stillThere ?? screen.getPrimaryDisplay(), evt)
    })
  }

  startForegroundWatcher()
  startBridge()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
