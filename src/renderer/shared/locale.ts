import type { Language } from '../../shared/settings/schema'

/** BCP 47 locale for Intl formatting. DOM-free, so pure modules (and their unit tests) can use it. */
export function locale(language: Language): string {
  return language === 'es' ? 'es-ES' : 'en-US'
}
