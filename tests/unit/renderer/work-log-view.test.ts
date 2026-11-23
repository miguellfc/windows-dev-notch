import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveWorkLogEntry, workLogDates, workLogProgress, workLogStatusKey } from '../../../src/renderer/shared/work-log/format'
import { translate } from '../../../src/shared/i18n/messages'
import type { WorkLogEntryView } from '../../../src/shared/work-log/schema'

// The views need the DOM's `window`, which the tests' tsconfig does not have: they are loaded by a
// path the compiler does not follow, and described here by what these tests use.
interface DetailAction {
  key: string
  run: () => Promise<unknown>
}
interface WorkLogList {
  WorkLogList: ComponentType<{ entries: readonly WorkLogEntryView[]; now: number; idlePauseMs: number; onOpen: (sessionId: string) => void }>
}
interface WorkLogDetail {
  WorkLogDetail: ComponentType<{ entry: WorkLogEntryView; now: number; idlePauseMs: number; onBack: () => void; onDeleted: (sessionId: string) => void }>
  detailActions: (entry: WorkLogEntryView) => DetailAction[]
}
const LIST: string = '../../../src/renderer/notch/work-log/WorkLogList'
const DETAIL: string = '../../../src/renderer/notch/work-log/WorkLogDetail'
const importList = () => import(/* @vite-ignore */ LIST) as Promise<WorkLogList>
const importDetail = () => import(/* @vite-ignore */ DETAIL) as Promise<WorkLogDetail>

const M = 60_000
const H = 60 * M
const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('es', key, params)

/** 20 Nov 2026 09:00 local. */
const START = new Date(2026, 10, 20, 9, 0).getTime()

function entry(overrides: Partial<WorkLogEntryView> = {}): WorkLogEntryView {
  return {
    sessionId: 's1',
    accountId: 'claude-work',
    project: 'ms-pay',
    status: 'ready',
    invoiced: false,
    startedAt: START,
    endedAt: START + 26 * H,
    claudeMs: 3 * H + 10 * M,
    totalMs: 5 * H + 45 * M,
    live: null,
    title: 'Integrar la pasarela Cashela en ms-pay',
    subtasks: [
      ...Array.from({ length: 8 }, (_, i) => ({ title: `Hecha ${i + 1}`, status: 'done' as const, claudeMs: 10 * M, totalMs: 20 * M })),
      ...Array.from({ length: 6 }, (_, i) => ({ title: `Pendiente ${i + 1}`, status: 'pending' as const, claudeMs: null, totalMs: null })),
    ],
    ...overrides,
  }
}

/** The text a reader sees: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')

function stubNotch(workLog: Record<string, unknown>) {
  vi.stubGlobal('window', { notch: { workLog } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('work log format', () => {
  it('gives one date while running, and start – end once it spans days', () => {
    expect(workLogDates(entry(), 'es')).toBe('20/11 – 21/11')
    expect(workLogDates(entry({ endedAt: START + 2 * H }), 'es')).toBe('20/11')
    expect(workLogDates(entry({ status: 'running', endedAt: null, live: { lastEventAt: START, excessMs: 0, turnOpen: true, waitSince: null } }), 'es')).toBe('20/11')
  })

  it('counts the done subtasks, or names the project before a summary', () => {
    expect(workLogProgress(entry(), t)).toBe('8 de 14 hechas')
    expect(workLogProgress(entry({ subtasks: [] }), t)).toBe('ms-pay')
  })

  it('says each status, the invoiced one once ended', () => {
    expect(workLogStatusKey(entry({ status: 'running' }))).toBe('workLog.status.running')
    expect(workLogStatusKey(entry({ status: 'paused' }))).toBe('workLog.status.paused')
    expect(workLogStatusKey(entry({ status: 'summarizing' }))).toBe('workLog.status.summarizing')
    expect(workLogStatusKey(entry({ status: 'unsummarized' }))).toBe('workLog.status.unsummarized')
    expect(workLogStatusKey(entry())).toBe('workLog.status.uninvoiced')
    expect(workLogStatusKey(entry({ invoiced: true }))).toBe('workLog.status.invoiced')
  })

  it('picks the live entry with the latest event', () => {
    const live = (id: string, at: number, status: 'running' | 'paused' = 'running') =>
      entry({ sessionId: id, status, endedAt: null, live: { lastEventAt: at, excessMs: 0, turnOpen: false, waitSince: null } })
    expect(liveWorkLogEntry([entry()])).toBeNull()
    expect(liveWorkLogEntry([live('a', 5), live('b', 9, 'paused'), entry()])?.sessionId).toBe('b')
  })
})

describe('WorkLogList', () => {
  it('shows a ready entry with its times, progress, dates and pill', async () => {
    const { WorkLogList } = await importList()
    const html = renderToStaticMarkup(createElement(WorkLogList, { entries: [entry()], now: START + 30 * H, idlePauseMs: 30 * M, onOpen: () => {} }))
    const text = textOf(html)
    expect(text).toContain('Integrar la pasarela Cashela en ms-pay')
    expect(text).toContain('Claude 3h 10m · Total 5h 45m')
    expect(text).toContain('8 de 14 hechas')
    expect(text).toContain('20/11 – 21/11')
    expect(text).toContain('sin imputar')
  })
})

describe('WorkLogDetail', () => {
  it('offers Retry on an unsummarized entry, which asks main for a summary', async () => {
    const { WorkLogDetail, detailActions } = await importDetail()
    const unsummarized = entry({ status: 'unsummarized', subtasks: [] })
    const html = renderToStaticMarkup(createElement(WorkLogDetail, { entry: unsummarized, now: START + 30 * H, idlePauseMs: 30 * M, onBack: () => {}, onDeleted: () => {} }))
    expect(textOf(html)).toContain('Reintentar')

    const summarize = vi.fn(async () => ({ ok: true, data: { ok: true } }))
    stubNotch({ summarize })
    const retry = detailActions(unsummarized).find((action) => action.key === 'retry')
    expect(retry).toBeDefined()
    await retry?.run()
    expect(summarize).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('offers Close and summarize only while paused, and lists numbered subtasks', async () => {
    const { WorkLogDetail, detailActions } = await importDetail()
    const keys = (value: WorkLogEntryView) => detailActions(value).map((action) => action.key)
    expect(keys(entry())).toEqual(['copy', 'invoice', 'delete'])
    expect(keys(entry({ invoiced: true }))).toEqual(['copy', 'uninvoice', 'delete'])
    expect(keys(entry({ status: 'paused', endedAt: null, live: { lastEventAt: START, excessMs: 0, turnOpen: false, waitSince: null } }))).toContain('close')
    expect(keys(entry({ status: 'running', endedAt: null, live: { lastEventAt: START, excessMs: 0, turnOpen: true, waitSince: null } }))).not.toContain('close')
    const text = textOf(renderToStaticMarkup(createElement(WorkLogDetail, { entry: entry(), now: START + 30 * H, idlePauseMs: 30 * M, onBack: () => {}, onDeleted: () => {} })))
    expect(text).toContain('Hecha 1')
    expect(text).toContain('pendiente')
    expect(text).toContain('3h 10m')
  })
})

describe('WorkLogDetail: what each status offers', () => {
  const live = (status: 'running' | 'paused') => entry({ status, endedAt: null, live: { lastEventAt: START, excessMs: 0, turnOpen: status === 'running', waitSince: null } })

  it('offers neither Borrar nor imputar while summarizing', async () => {
    const { detailActions } = await importDetail()
    expect(detailActions(entry({ status: 'summarizing' })).map((action) => action.key)).toEqual(['copy'])
  })

  it('offers no Copiar while running: its figures still move', async () => {
    const { detailActions } = await importDetail()
    expect(detailActions(live('running')).map((action) => action.key)).toEqual([])
    expect(detailActions(live('paused')).map((action) => action.key)).toEqual(['copy', 'close'])
  })

  it('shows a paused entry with its stored total, not a growing one', async () => {
    const { WorkLogDetail } = await importDetail()
    const paused = { ...live('paused'), totalMs: 50 * M, subtasks: [] }
    const html = renderToStaticMarkup(createElement(WorkLogDetail, { entry: paused, now: START + 30 * H, idlePauseMs: 30 * M, onBack: () => {}, onDeleted: () => {} }))
    expect(textOf(html)).toContain('50m')
  })
})

describe('WorkLogDetail: subtasks', () => {
  const twoHalves = entry({
    claudeMs: 21 * M,
    totalMs: 21 * M,
    subtasks: [
      { title: 'A', status: 'done', claudeMs: 10.5 * M, totalMs: 10.5 * M },
      { title: 'B', status: 'done', claudeMs: 10.5 * M, totalMs: 10.5 * M },
      { title: 'C', status: 'pending', claudeMs: null, totalMs: null },
    ],
  })

  it('rounds the subtask minutes so they add up to the shown figures', async () => {
    const { WorkLogDetail } = await importDetail()
    const text = textOf(renderToStaticMarkup(createElement(WorkLogDetail, { entry: twoHalves, now: START, idlePauseMs: 30 * M, onBack: () => {}, onDeleted: () => {} })))
    expect(text).toContain('A11m · 11m')
    expect(text).toContain('B10m · 10m')
  })

  it('names each subtask button with its times, or pending', async () => {
    const { WorkLogDetail } = await importDetail()
    const html = renderToStaticMarkup(createElement(WorkLogDetail, { entry: twoHalves, now: START, idlePauseMs: 30 * M, onBack: () => {}, onDeleted: () => {} }))
    const labels = [...html.matchAll(/data-testid="work-log-subtask"[^>]*aria-label="([^"]*)"/g)].map((match) => match[1])
    expect(labels).toEqual(['Copiar la subtarea 1: A, Claude 11m · Total 11m', 'Copiar la subtarea 2: B, Claude 10m · Total 10m', 'Copiar la subtarea 3: C, pendiente'])
  })
})

describe('WorkLogList: one card per entry', () => {
  it('draws each entry as its own card', async () => {
    const { WorkLogList } = await importList()
    const html = renderToStaticMarkup(
      createElement(WorkLogList, { entries: [entry(), entry({ sessionId: 's2' })], now: START + 30 * H, idlePauseMs: 30 * M, onOpen: () => {} }),
    )
    const list = /<ul[^>]*>/.exec(html)?.[0] ?? ''
    expect(list).not.toMatch(/class="[^"]*\bcard\b/)
    expect([...html.matchAll(/<li[^>]*class="[^"]*\bcard\b[^"]*"/g)]).toHaveLength(2)
  })
})
