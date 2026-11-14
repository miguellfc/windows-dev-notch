// Throwaway spike: do Windows toasts show action buttons and deliver clicks?
const { app, Notification } = require('electron')
const fs = require('fs')
const path = require('path')
const LOG = path.join(__dirname, 'events.log')
fs.writeFileSync(LOG, '')
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`)
const ser = (v) => { try { return JSON.stringify(v) } catch { return String(v) } }

app.setAppUserModelId('com.spike.toastactions')
app.whenReady().then(() => {
  log(`ready supported=${Notification.isSupported()} electron=${process.versions.electron}`)
  const hook = (n, tag) => {
    for (const ev of ['show', 'click', 'action', 'close', 'failed', 'reply']) {
      n.on(ev, (...args) => log(`${tag} ${ev} ${ser(args.map((a) => (a && a.constructor && a.constructor.name === 'Object') || typeof a !== 'object' ? a : { ...a }))}`))
    }
  }
  const v1 = new Notification({
    title: 'V1 spike', body: 'Variant 1: actions',
    actions: [{ type: 'button', text: 'Posponer' }, { type: 'button', text: 'Completar' }]
  })
  hook(v1, 'V1')
  const WANT = process.env.VARIANT || '12'
  if (WANT.includes('1')) setTimeout(() => { log('V1 show()'); v1.show() }, 2000)

  const xml = `<toast launch="body"><visual><binding template="ToastGeneric"><text>V2 spike</text><text>Variant 2: toastXml</text></binding></visual><actions><action content="Posponer" arguments="snooze" activationType="foreground"/><action content="Completar" arguments="done" activationType="foreground"/></actions></toast>`
  const v2 = new Notification({ title: 'V2', body: 'V2', toastXml: xml })
  hook(v2, 'V2')
  if (WANT.includes('2')) setTimeout(() => { log('V2 show()'); v2.show() }, WANT.includes('1') ? 8000 : 2000)
  setTimeout(() => { log('quit'); app.quit() }, 170000)
})
