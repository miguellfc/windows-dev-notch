import { ArrowLeft } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { useT } from '../shared/use-t'

/** What the terminal panel shows when its chunk could not load: the reason and a way back. */
function TerminalLoadFailed() {
  const t = useT()
  return (
    <div className="flex h-full flex-col" data-testid="terminal-view" data-status="unavailable">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <button
          type="button"
          onClick={() => void window.notch.notch.back()}
          aria-label={t('terminal.back')}
          title={t('terminal.back')}
          className="flex size-6 cursor-pointer items-center justify-center rounded-control-sm text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk"
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <span role="status" className="ml-auto truncate text-label text-graphite">
          {t('terminal.unavailable')}
        </span>
      </header>
    </div>
  )
}

/**
 * Keeps a failed terminal chunk load (or a crash inside the terminal view) inside the terminal
 * panel, so the rest of the notch keeps working. It unmounts with the panel, so the next open
 * starts clean and retries the load.
 */
export class TerminalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? <TerminalLoadFailed /> : this.props.children
  }
}
