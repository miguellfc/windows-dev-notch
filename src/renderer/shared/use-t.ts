import { useCallback, useEffect } from 'react'
import { translate, type MessageKey, type MessageParams } from '../../shared/i18n/messages'
import type { Language } from '../../shared/settings/schema'
import { useSettings } from './settings-store'

export function useLanguage(): Language {
  return useSettings((state) => state.settings?.language ?? 'es')
}

/** Translation function for the current language; also keeps `<html lang>` accurate. */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const language = useLanguage()
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  return useCallback((key, params) => translate(language, key, params), [language])
}

export function locale(language: Language): string {
  return language === 'es' ? 'es-ES' : 'en-US'
}
