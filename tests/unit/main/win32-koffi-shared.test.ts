import { describe, expect, it } from 'vitest'
import { createWin32ForegroundProbe } from '../../../src/main/platform/win32'
import { createWin32FocusApi } from '../../../src/main/claude/bring-claude-to-front'
import { createMemoryLogger } from '../helpers/memory-logger'

describe.skipIf(process.platform !== 'win32')('shared koffi type registration', () => {
  it('lets the foreground probe and the focus API coexist, repeatedly', () => {
    const logger = createMemoryLogger()
    expect(createWin32ForegroundProbe(logger)).not.toBeNull()
    expect(createWin32FocusApi(logger)).not.toBeNull()
    expect(createWin32FocusApi(logger)).not.toBeNull()
  })
})
