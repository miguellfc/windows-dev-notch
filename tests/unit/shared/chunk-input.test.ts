import { describe, expect, it } from 'vitest'
import { TERMINAL_INPUT_MAX } from '../../../src/shared/ipc/contract'
import { chunkInput } from '../../../src/shared/terminal/chunk-input'

describe('chunkInput', () => {
  it('splits a large paste into chunks the IPC contract accepts', () => {
    expect(chunkInput('a'.repeat(TERMINAL_INPUT_MAX + 1)).map((c) => c.length)).toEqual([TERMINAL_INPUT_MAX, 1])
  })

  it('keeps small input in one piece and drops empty input', () => {
    expect(chunkInput('dir\r')).toEqual(['dir\r'])
    expect(chunkInput('')).toEqual([])
  })

  it('never splits a surrogate pair', () => {
    const chunks = chunkInput('ab😀cd', 3)
    expect(chunks.join('')).toBe('ab😀cd')
    expect(chunks).toEqual(['ab', '😀c', 'd'])
  })
})
