import { describe, expect, it } from 'vitest'
import { createLatestRequests } from '../../../src/renderer/control-center/latest-request'

describe('createLatestRequests', () => {
  it('only the newest request of a key is current', () => {
    const requests = createLatestRequests<'github' | 'gitlab'>()
    const first = requests.begin('github')
    const second = requests.begin('github')
    expect(requests.isCurrent('github', first)).toBe(false)
    expect(requests.isCurrent('github', second)).toBe(true)
  })

  it('keys do not supersede each other', () => {
    const requests = createLatestRequests<'github' | 'gitlab'>()
    const github = requests.begin('github')
    requests.begin('gitlab')
    expect(requests.isCurrent('github', github)).toBe(true)
  })

  it('a double click shows the answer of the last request only', async () => {
    const requests = createLatestRequests<'github'>()
    const shown: string[] = []
    const run = async (answer: string, ms: number) => {
      const seq = requests.begin('github')
      await new Promise((resolve) => setTimeout(resolve, ms))
      if (requests.isCurrent('github', seq)) shown.push(answer)
    }
    // The superseded request resolves first with a false "network".
    await Promise.all([run('network', 5), run('ok', 15)])
    expect(shown).toEqual(['ok'])
  })

  it('cancel makes pending requests stale', () => {
    const requests = createLatestRequests<'github'>()
    const seq = requests.begin('github')
    requests.begin('github') // e.g. Quitar
    expect(requests.isCurrent('github', seq)).toBe(false)
  })
})
