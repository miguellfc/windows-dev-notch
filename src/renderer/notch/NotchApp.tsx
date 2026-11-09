import { useEffect, useState } from 'react'
import type { Result } from '../../shared/ipc/result'
import type { Language, Settings } from '../../shared/settings/schema'

const LANGUAGES: readonly Language[] = ['es', 'en']

/**
 * Skeleton vertical slice: reads settings through the typed IPC bridge and lets the
 * user switch language, proving renderer → preload → main → disk end to end.
 * The real capsule replaces this after the M0 spike.
 */
export function NotchApp() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = (result: Result<Settings>) => {
    if (result.ok) {
      setSettings(result.data)
      setError(null)
    } else {
      setError(result.error.message)
    }
  }

  useEffect(() => {
    void window.notch.settings.get().then(apply)
  }, [])

  const choose = (language: Language) => {
    void window.notch.settings.update({ language }).then(apply)
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3">
      <section
        data-testid="notch-capsule"
        className="flex h-9 items-center gap-3 rounded-full border border-line bg-obsidian px-3.5 text-[13px] text-chalk shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.55)]"
      >
        <span className="font-medium">Developer Notch</span>
        <span className="h-3.5 w-px bg-line" aria-hidden="true" />
        <div role="group" aria-label="Language" className="flex gap-1">
          {LANGUAGES.map((language) => (
            <button
              key={language}
              type="button"
              aria-pressed={settings?.language === language}
              disabled={!settings}
              onClick={() => choose(language)}
              className="cursor-pointer rounded-full px-2 py-0.5 text-[11px] font-medium uppercase text-graphite transition-colors duration-150 hover:text-chalk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ice aria-pressed:bg-ice aria-pressed:text-abyss disabled:cursor-default"
            >
              {language}
            </button>
          ))}
        </div>
        <span data-testid="notch-language" className="sr-only">
          {settings?.language ?? ''}
        </span>
      </section>
      {error ? (
        <p role="alert" className="text-[12.5px] text-fail">
          {error}
        </p>
      ) : null}
    </main>
  )
}
