// Throwaway spike: the same capsule page in a minimal Electron, with the same cursor polling as
// the Tauri side, so the memory comparison measures the runtime and not the app.
const path = require('node:path')
const { app, BrowserWindow, screen } = require('electron')

const WIDTH = 760
const HEIGHT = 114
const TOP = 6
const PEEK = 168
const COMPACT = 358
const CAPSULE_HEIGHT = 36

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
  win.once('ready-to-show', () => win.showInactive())

  let display = null
  let inside = false
  setInterval(() => {
    const point = screen.getCursorScreenPoint()
    const current = screen.getDisplayNearestPoint(point)
    if (current.id !== display) {
      display = current.id
      const area = current.workArea
      win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y, width: WIDTH, height: HEIGHT })
    }
    const bounds = win.getBounds()
    const width = inside ? COMPACT : PEEK
    const left = bounds.x + (WIDTH - width) / 2
    const now =
      point.x >= left && point.x < left + width && point.y >= bounds.y + TOP && point.y < bounds.y + TOP + CAPSULE_HEIGHT
    if (now !== inside) {
      inside = now
      win.setIgnoreMouseEvents(!inside)
      win.webContents.send('hover', inside)
    }
  }, 33)
})
