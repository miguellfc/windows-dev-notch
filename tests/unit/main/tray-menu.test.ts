import { describe, expect, it, vi } from 'vitest'
import { buildTrayMenu, type TrayMenuOptions } from '../../../src/main/platform/tray-menu'

const options = (overrides: Partial<TrayMenuOptions> = {}): TrayMenuOptions => ({
  language: 'es',
  notchVisible: true,
  launchAtLogin: false,
  launchAtLoginAvailable: true,
  actions: {
    toggleVisibility: vi.fn(),
    openControlCenter: vi.fn(),
    setLaunchAtLogin: vi.fn(),
    quit: vi.fn(),
  },
  ...overrides,
})

const labels = (opts: TrayMenuOptions) =>
  buildTrayMenu(opts).map((item) => ('label' in item ? item.label : '---'))

describe('buildTrayMenu', () => {
  it('lists the actions in the chosen language', () => {
    expect(labels(options())).toEqual(['Ocultar', 'Control Center', '---', 'Iniciar con Windows', '---', 'Salir'])
    expect(labels(options({ language: 'en', notchVisible: false }))).toEqual([
      'Show',
      'Control Center',
      '---',
      'Start with Windows',
      '---',
      'Quit',
    ])
  })

  it('reflects and toggles start with Windows', () => {
    const opts = options({ launchAtLogin: true })
    const item = buildTrayMenu(opts).find((i) => 'label' in i && i.label === 'Iniciar con Windows')
    expect(item).toMatchObject({ type: 'checkbox', checked: true, enabled: true })
    if (item && 'click' in item) item.click?.()
    expect(opts.actions.setLaunchAtLogin).toHaveBeenCalledWith(false)
  })

  it('disables start with Windows when it is not available', () => {
    const item = buildTrayMenu(options({ launchAtLoginAvailable: false })).find(
      (i) => 'label' in i && i.label === 'Iniciar con Windows',
    )
    expect(item).toMatchObject({ enabled: false })
  })

  it('wires every action', () => {
    const opts = options()
    for (const item of buildTrayMenu(opts)) if ('click' in item) item.click?.()
    expect(opts.actions.toggleVisibility).toHaveBeenCalled()
    expect(opts.actions.openControlCenter).toHaveBeenCalled()
    expect(opts.actions.quit).toHaveBeenCalled()
  })
})
