import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { chunkInput } from '../../shared/terminal/chunk-input'
import { useT } from '../shared/use-t'
import { obsidianTerminalTheme } from './terminal-theme'

type Status = 'starting' | 'running' | 'unavailable'

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

/**
 * The embedded PowerShell. The session lives in the main process; this view only renders it.
 * Output events are ignored until `terminal:open` answers: the snapshot it returns already
 * holds everything sent before, so the history is never painted twice.
 */
export function TerminalView() {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('starting')
  const [shell, setShell] = useState('')

  useEffect(() => {
    const element = host.current
    if (!element) return
    const term = new Terminal({
      theme: obsidianTerminalTheme,
      // Geist Mono sets the grid; installed Nerd Fonts (never downloaded) only fill in the prompt
      // icons that themes such as oh-my-posh print and Geist Mono lacks.
      fontFamily: [
        "'Geist Mono Variable'",
        "'Symbols Nerd Font Mono'",
        "'FiraCode Nerd Font Mono'",
        "'CaskaydiaCove Nerd Font Mono'",
        "'JetBrainsMono Nerd Font Mono'",
        "'Cascadia Mono'",
        'Consolas',
        'monospace',
      ].join(', '),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)

    let attached = false
    let disposed = false

    const sendSize = () => {
      if (disposed || element.clientWidth === 0) return
      fit.fit()
      if (term.cols >= 2 && term.rows >= 1) void window.notch.terminal.resize({ cols: term.cols, rows: term.rows })
    }

    const attach = async () => {
      attached = false
      const result = await window.notch.terminal.open()
      if (disposed) return
      if (!result.ok) {
        setStatus('unavailable')
        return
      }
      setShell(fileName(result.data.shell))
      setStatus('running')
      term.reset()
      term.write(result.data.snapshot)
      attached = true
      sendSize()
      term.focus()
    }

    const offData = window.notch.events.on('terminal:data', (chunk) => {
      if (attached) term.write(chunk)
    })
    // When the shell exits (`exit`), main closes the panel; the next open starts a new shell.
    const input = term.onData((data) => {
      if (!attached) return
      for (const chunk of chunkInput(data)) void window.notch.terminal.input({ data: chunk })
    })
    // The panel springs from 440 to 640 px; resize the pty once it settles, not on every frame
    // (each resize makes ConPTY reflow and PSReadLine redraw the prompt).
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(sendSize, 60)
    })
    observer.observe(element)
    // While the terminal is shown the keyboard belongs to it. Focus can fall to <body> when the
    // tile that opened this view unmounts, or when the window regains OS focus; take it back.
    const refocus = () => {
      setTimeout(() => {
        if (!disposed && (document.activeElement === null || document.activeElement === document.body)) term.focus()
      })
    }
    window.addEventListener('focus', refocus)
    document.addEventListener('focusout', refocus)

    void attach()
    term.focus()

    return () => {
      disposed = true
      clearTimeout(resizeTimer)
      window.removeEventListener('focus', refocus)
      document.removeEventListener('focusout', refocus)
      observer.disconnect()
      input.dispose()
      offData()
      term.dispose()
    }
  }, [])

  const notice = status === 'unavailable' ? t('terminal.unavailable') : null

  return (
    <div className="flex h-full flex-col" data-testid="terminal-view" data-status={status}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <button
          type="button"
          onClick={() => void window.notch.notch.back()}
          aria-label={t('terminal.back')}
          title={t('terminal.back')}
          className="flex size-6 cursor-pointer items-center justify-center rounded-[8px] text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk"
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <span className="truncate font-mono text-label text-graphite">{shell}</span>
        {notice && (
          <span role="status" className="ml-auto truncate text-label text-graphite">
            {notice}
          </span>
        )}
      </header>
      <div ref={host} className="min-h-0 flex-1 px-2 pb-2 pt-1.5" data-testid="terminal-host" />
    </div>
  )
}
