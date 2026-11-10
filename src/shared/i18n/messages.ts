import type { Language } from '../settings/schema'

const es = {
  'notch.peekHint': 'Pulsa {shortcut}',
  'notch.panel.controlCenter': 'Control Center',
  'notch.panel.hide': 'Ocultar',
  'notch.panel.escHint': 'Esc para cerrar',
  'notch.integrations.label': 'Integraciones',
  'integration.terminal': 'Terminal',
  'terminal.back': 'Volver',
  'terminal.unavailable': 'No se pudo iniciar PowerShell',
  'tray.show': 'Mostrar',
  'tray.hide': 'Ocultar',
  'tray.controlCenter': 'Control Center',
  'tray.launchAtLogin': 'Iniciar con Windows',
  'tray.quit': 'Salir',
  'cc.title': 'Control Center',
  'cc.nav.general': 'General',
  'cc.nav.shortcut': 'Atajo',
  'cc.nav.about': 'Acerca de',
  'cc.general.language': 'Idioma',
  'cc.general.languageHint': 'Idioma de la cápsula, el panel y las notificaciones.',
  'cc.general.launchAtLogin': 'Iniciar con Windows',
  'cc.general.launchAtLoginHint': 'Abre Developer Notch al iniciar sesión.',
  'cc.general.launchAtLoginUnavailable': 'Disponible solo en la versión instalada.',
  'cc.shortcut.title': 'Atajo global',
  'cc.shortcut.description': 'Abre el panel desde cualquier aplicación.',
  'cc.shortcut.change': 'Cambiar',
  'cc.shortcut.recording': 'Pulsa la nueva combinación…',
  'cc.shortcut.cancel': 'Cancelar',
  'cc.shortcut.saved': 'Atajo guardado.',
  'cc.shortcut.unavailable': 'Otra aplicación ya usa {shortcut}. Elige otra combinación.',
  'cc.shortcut.needsModifier': 'Incluye al menos Ctrl, Alt o Win.',
  'cc.shortcut.unsupported': 'Esa tecla no se puede usar. Prueba con una letra, un número o F1–F24.',
  'cc.shortcut.notRegistered': 'El atajo guardado no está activo: otra aplicación lo usa. Elige otro.',
  'cc.about.version': 'Versión {version}',
  'cc.about.description': 'Cápsula de atención para desarrolladores en Windows.',
  'error.generic': 'Algo falló. Vuelve a intentarlo.',
  'error.readOnly': 'La configuración está en solo lectura en esta sesión.',
} as const

export type MessageKey = keyof typeof es

const en: Record<MessageKey, string> = {
  'notch.peekHint': 'Press {shortcut}',
  'notch.panel.controlCenter': 'Control Center',
  'notch.panel.hide': 'Hide',
  'notch.panel.escHint': 'Esc to close',
  'notch.integrations.label': 'Integrations',
  'integration.terminal': 'Terminal',
  'terminal.back': 'Back',
  'terminal.unavailable': 'PowerShell could not start',
  'tray.show': 'Show',
  'tray.hide': 'Hide',
  'tray.controlCenter': 'Control Center',
  'tray.launchAtLogin': 'Start with Windows',
  'tray.quit': 'Quit',
  'cc.title': 'Control Center',
  'cc.nav.general': 'General',
  'cc.nav.shortcut': 'Shortcut',
  'cc.nav.about': 'About',
  'cc.general.language': 'Language',
  'cc.general.languageHint': 'Language of the capsule, the panel and notifications.',
  'cc.general.launchAtLogin': 'Start with Windows',
  'cc.general.launchAtLoginHint': 'Opens Developer Notch when you sign in.',
  'cc.general.launchAtLoginUnavailable': 'Only available in the installed app.',
  'cc.shortcut.title': 'Global shortcut',
  'cc.shortcut.description': 'Opens the panel from any app.',
  'cc.shortcut.change': 'Change',
  'cc.shortcut.recording': 'Press the new combination…',
  'cc.shortcut.cancel': 'Cancel',
  'cc.shortcut.saved': 'Shortcut saved.',
  'cc.shortcut.unavailable': 'Another app already uses {shortcut}. Pick another combination.',
  'cc.shortcut.needsModifier': 'Include at least Ctrl, Alt or Win.',
  'cc.shortcut.unsupported': 'That key cannot be used. Try a letter, a number or F1–F24.',
  'cc.shortcut.notRegistered': 'The saved shortcut is not active: another app uses it. Pick another one.',
  'cc.about.version': 'Version {version}',
  'cc.about.description': 'Attention capsule for developers on Windows.',
  'error.generic': 'Something went wrong. Try again.',
  'error.readOnly': 'Settings are read-only in this session.',
}

export const messages: Record<Language, Record<MessageKey, string>> = { es, en }

export type MessageParams = Readonly<Record<string, string | number>>

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const template = messages[language][key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
