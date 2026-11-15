import { describe, expect, it } from 'vitest'
import { createCodeReviewUpdater, type CodeReviewAlerts, type CodeReviewSettings } from '../../../src/renderer/control-center/code-review-settings-patch'
import { createBlockUpdater } from '../../../src/renderer/control-center/settings-block-patch'

const base = (): CodeReviewSettings => ({
  gitlabUrl: '',
  alerts: { github: { enabled: true, sound: true }, gitlab: { enabled: true, sound: true } },
})

describe('createCodeReviewUpdater', () => {
  it('builds each patch from the block left by the previous update', async () => {
    let stored = base()
    const sent: CodeReviewAlerts[] = []
    const update = createCodeReviewUpdater(
      () => stored,
      async ({ codeReview }) => {
        sent.push(codeReview.alerts)
        await new Promise((resolve) => setTimeout(resolve, 10))
        stored = { ...stored, ...codeReview } // the store only changes once the IPC resolves
        return { ok: true }
      },
    )
    const first = update((c) => ({ alerts: { ...c.alerts, github: { ...c.alerts.github, enabled: false } } }))
    const second = update((c) => ({ alerts: { ...c.alerts, gitlab: { ...c.alerts.gitlab, sound: false } } }))
    await Promise.all([first, second])
    expect(sent[1]).toEqual({ github: { enabled: false, sound: true }, gitlab: { enabled: true, sound: false } })
    expect(stored.alerts.github.enabled).toBe(false)
  })

  it('keeps going after a failed update', async () => {
    let stored = base()
    let calls = 0
    const update = createCodeReviewUpdater(
      () => stored,
      async ({ codeReview }) => {
        if (calls++ === 0) throw new Error('boom')
        stored = { ...stored, ...codeReview }
        return { ok: true }
      },
    )
    await expect(update((c) => c)).rejects.toThrow('boom')
    await update((c) => ({ alerts: { ...c.alerts, github: { enabled: false, sound: false } } }))
    expect(stored.alerts.github).toEqual({ enabled: false, sound: false })
  })


  it('sends only the alerts, so a URL main wrote meanwhile is not restored', async () => {
    let stored = base()
    const sent: unknown[] = []
    const update = createCodeReviewUpdater(
      () => stored,
      async (patch) => {
        sent.push(patch)
        return { ok: true }
      },
    )
    stored = { ...stored, gitlabUrl: 'https://gitlab.example.com' } // main saved the URL
    await update((c) => ({ alerts: { ...c.alerts, github: { enabled: false, sound: true } } }))
    expect(Object.keys((sent[0] as { codeReview: object }).codeReview)).toEqual(['alerts'])
  })
})

describe('createBlockUpdater', () => {
  it('sends the patch under the given key', async () => {
    const sent: unknown[] = []
    const update = createBlockUpdater<'x', { n: number }, void>(
      'x',
      () => ({ n: 1 }),
      async (patch) => void sent.push(patch),
    )
    await update((latest) => ({ n: latest.n + 1 }))
    expect(sent).toEqual([{ x: { n: 2 } }])
  })
})
