import { Activity, AlarmClock, Bot, GitPullRequest, Info, Keyboard, Mail, Settings2, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { AboutPage } from './AboutPage'
import { ClaudePage } from './ClaudePage'
import { CodeReviewPage } from './CodeReviewPage'
import { GeneralPage } from './GeneralPage'
import { GmailPage } from './GmailPage'
import { RemindersPage } from './RemindersPage'
import { ShortcutPage } from './ShortcutPage'
import { SystemPage } from './SystemPage'

type PageId = 'general' | 'shortcut' | 'claude' | 'reminders' | 'system' | 'gmail' | 'code-review' | 'about'

const PAGES: readonly { id: PageId; label: MessageKey; icon: LucideIcon }[] = [
  { id: 'general', label: 'cc.nav.general', icon: Settings2 },
  { id: 'shortcut', label: 'cc.nav.shortcut', icon: Keyboard },
  { id: 'claude', label: 'cc.nav.claude', icon: Bot },
  { id: 'reminders', label: 'cc.nav.reminders', icon: AlarmClock },
  { id: 'system', label: 'cc.nav.system', icon: Activity },
  { id: 'gmail', label: 'cc.nav.gmail', icon: Mail },
  { id: 'code-review', label: 'cc.nav.codeReview', icon: GitPullRequest },
  { id: 'about', label: 'cc.nav.about', icon: Info },
]

export interface Runtime {
  isPackaged: boolean
  shortcutRegistered: boolean
}

/** The page the notch asked for, carried in the URL hash (`#gmail`), if this list has it. */
const requestedPage = (): PageId | null => PAGES.find((p) => p.id === window.location.hash.slice(1))?.id ?? null

export function ControlCenterApp() {
  const t = useT()
  const settings = useSettings((state) => state.settings)
  const [page, setPage] = useState<PageId>(() => requestedPage() ?? 'general')
  useEffect(() => {
    // Main navigates an open window to the hash (a same-document change once loaded). Clearing it
    // once read lets the next request for the same page change it again and fire `hashchange`.
    const take = () => {
      const requested = requestedPage()
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
      if (requested) setPage(requested)
    }
    take()
    window.addEventListener('hashchange', take)
    return () => window.removeEventListener('hashchange', take)
  }, [])
  const [runtime, setRuntime] = useState<Runtime | null>(null)

  const refreshRuntime = () => {
    void window.notch.app.getRuntime().then((result) => {
      if (result.ok) setRuntime(result.data)
    })
  }
  useEffect(refreshRuntime, [])

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0]!

  let content: ReactNode = null
  if (settings && runtime) {
    if (page === 'general') content = <GeneralPage settings={settings} runtime={runtime} />
    else if (page === 'shortcut') content = <ShortcutPage settings={settings} runtime={runtime} onChanged={refreshRuntime} />
    else if (page === 'claude') content = <ClaudePage />
    else if (page === 'reminders') content = <RemindersPage settings={settings} />
    else if (page === 'system') content = <SystemPage settings={settings} />
    else if (page === 'gmail') content = <GmailPage settings={settings} />
    else if (page === 'code-review') content = <CodeReviewPage settings={settings} />
    else content = <AboutPage />
  }

  return (
    <div className="flex h-screen text-body text-chalk">
      <aside className="flex w-44 shrink-0 flex-col border-r border-line bg-black/20">
        <div className="drag flex h-10 items-center px-4 text-small text-graphite">{t('cc.title')}</div>
        <nav aria-label={t('cc.title')} className="flex flex-col gap-0.5 px-2 py-2">
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={id === page ? 'page' : undefined}
              onClick={() => setPage(id)}
              className="flex h-9 cursor-pointer items-center gap-3 rounded-control px-3 text-left text-graphite transition-colors duration-150 hover:text-chalk aria-[current=page]:bg-veil-tile aria-[current=page]:text-chalk"
            >
              <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
              {t(label)}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="drag h-10" />
        <section className="max-w-[560px] px-8 pb-8">
          <h1 className="mb-4 text-title font-semibold">{t(current.label)}</h1>
          {content}
        </section>
      </main>
    </div>
  )
}

/** One setting: label and explanation on the left, control on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-body text-chalk">{label}</div>
        {hint ? <div className="mt-1 text-small text-graphite">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
