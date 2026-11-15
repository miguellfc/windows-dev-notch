import { describe, expect, it, vi } from 'vitest'
import { syncLaunchAtLogin } from '../../../src/main/platform/auto-launch'

const fakeApp = (isPackaged: boolean, applies = true) => {
  let openAtLogin = false
  return {
    isPackaged,
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
      if (applies) openAtLogin = settings.openAtLogin
    }),
    getLoginItemSettings: () => ({ openAtLogin }),
  }
}

describe('syncLaunchAtLogin', () => {
  it('does nothing in development builds', () => {
    const app = fakeApp(false)
    expect(syncLaunchAtLogin(true, app)).toEqual({ applied: false, reason: 'not-packaged' })
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('enables and disables start with Windows in the installed app', () => {
    const app = fakeApp(true)
    expect(syncLaunchAtLogin(true, app)).toEqual({ applied: true })
    expect(app.getLoginItemSettings().openAtLogin).toBe(true)
    expect(syncLaunchAtLogin(false, app)).toEqual({ applied: true })
    expect(app.getLoginItemSettings().openAtLogin).toBe(false)
  })

  it('reports when Windows did not accept the change', () => {
    expect(syncLaunchAtLogin(true, fakeApp(true, false))).toEqual({ applied: false, reason: 'rejected' })
  })
})
