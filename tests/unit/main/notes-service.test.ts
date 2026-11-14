import { describe, expect, it, vi } from 'vitest'
import { createNotesService } from '../../../src/main/notes/notes-service'
import type { NotesStore } from '../../../src/main/notes/notes-store'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import { NOTES_MAX, type Note } from '../../../src/shared/notes/schema'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = new Date('2026-11-11T12:00:00.000Z')

function setup(start = T0) {
  let current = start
  let seq = 0
  let items: readonly Note[] = []
  const write = vi.fn(async (next: readonly Note[]) => {
    items = next
  })
  const store: NotesStore = { load: async () => 'ok', all: () => items, write }
  const onChange = vi.fn()
  const service = createNotesService({
    store,
    now: () => current,
    newId: () => uuid(++seq),
    onChange,
  })
  return {
    service,
    write,
    onChange,
    seed: (list: Note[]) => {
      items = list
    },
    items: () => items,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

const note = (n: number, over: Partial<Note> = {}): Note => ({
  id: uuid(n),
  text: `n${n}`,
  pinned: false,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
  ...over,
})

const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ExposedIpcError)
  expect((err as ExposedIpcError).code).toBe(code)
}

describe('notes service', () => {
  it('creates a trimmed note with id, dates and pinned=false', async () => {
    const { service, items, onChange } = setup()
    const created = await service.create('  hello\nworld  ')
    expect(created).toEqual({
      id: uuid(1),
      text: 'hello\nworld',
      pinned: false,
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    })
    expect(items()).toEqual([created])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid text with INVALID_INPUT and writes nothing', async () => {
    const { service, write } = setup()
    await rejectsWith(service.create('   '), 'INVALID_INPUT')
    await rejectsWith(service.create('a'.repeat(2001)), 'INVALID_INPUT')
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects the 501st note with INVALID_INPUT', async () => {
    const { service, seed } = setup()
    seed(Array.from({ length: NOTES_MAX }, (_, i) => note(i + 1)))
    await rejectsWith(service.create('one more'), 'INVALID_INPUT')
  })

  it('list returns pinned first, then by updatedAt desc', async () => {
    const { service, seed } = setup()
    seed([
      note(1, { updatedAt: '2026-11-03T00:00:00.000Z' }),
      note(2, { updatedAt: '2026-11-05T00:00:00.000Z' }),
      note(3, { pinned: true, updatedAt: '2026-11-01T00:00:00.000Z' }),
    ])
    expect(service.list().map((n) => n.id)).toEqual([uuid(3), uuid(2), uuid(1)])
  })

  it('update changes text and updatedAt, keeps createdAt and pinned', async () => {
    const { service, seed, advance } = setup()
    seed([note(1, { pinned: true })])
    advance(5000)
    const updated = await service.update(uuid(1), '  new text ')
    expect(updated).toEqual(
      note(1, { pinned: true, text: 'new text', updatedAt: new Date(T0.getTime() + 5000).toISOString() }),
    )
  })

  it('update rejects invalid text', async () => {
    const { service, seed } = setup()
    seed([note(1)])
    await rejectsWith(service.update(uuid(1), ''), 'INVALID_INPUT')
  })

  it('setPinned does not change updatedAt', async () => {
    const { service, seed, advance } = setup()
    seed([note(1)])
    advance(5000)
    const pinned = await service.setPinned(uuid(1), true)
    expect(pinned).toEqual(note(1, { pinned: true }))
    expect((await service.setPinned(uuid(1), false)).pinned).toBe(false)
  })

  it('throws NOT_FOUND for unknown ids', async () => {
    const { service } = setup()
    await rejectsWith(service.update(uuid(9), 'x'), 'NOT_FOUND')
    await rejectsWith(service.setPinned(uuid(9), true), 'NOT_FOUND')
    await rejectsWith(service.remove(uuid(9)), 'NOT_FOUND')
    await rejectsWith(service.restore(uuid(9)), 'NOT_FOUND')
    expect(() => service.text(uuid(9))).toThrowError(ExposedIpcError)
  })

  it('remove returns a copy of the removed note and drops it', async () => {
    const { service, seed, items } = setup()
    const original = note(1)
    seed([original, note(2)])
    const removed = await service.remove(uuid(1))
    expect(removed).toEqual(original)
    expect(removed).not.toBe(original)
    expect(items().map((n) => n.id)).toEqual([uuid(2)])
  })

  it('restore within 10 s reinserts the note with its original dates and pinned', async () => {
    const { service, seed, items, advance } = setup()
    const original = note(1, { pinned: true })
    seed([original])
    await service.remove(uuid(1))
    advance(10_000)
    const restored = await service.restore(uuid(1))
    expect(restored).toEqual(original)
    expect(items()).toEqual([original])
  })

  it('restore after 10 001 ms is NOT_FOUND', async () => {
    const { service, seed, advance } = setup()
    seed([note(1)])
    await service.remove(uuid(1))
    advance(10_001)
    await rejectsWith(service.restore(uuid(1)), 'NOT_FOUND')
  })

  it('restore of an id that exists again is NOT_FOUND', async () => {
    const { service, seed } = setup()
    seed([note(1)])
    await service.remove(uuid(1))
    seed([note(1, { text: 'reborn' })])
    await rejectsWith(service.restore(uuid(1)), 'NOT_FOUND')
  })

  it('restore consumes the buffer entry (second restore is NOT_FOUND)', async () => {
    const { service, seed } = setup()
    seed([note(1)])
    await service.remove(uuid(1))
    await service.restore(uuid(1))
    await rejectsWith(service.restore(uuid(1)), 'NOT_FOUND')
  })

  it('two consecutive deletions are restorable separately', async () => {
    const { service, seed, items } = setup()
    seed([note(1), note(2)])
    await service.remove(uuid(1))
    await service.remove(uuid(2))
    expect(items()).toEqual([])
    await service.restore(uuid(2))
    await service.restore(uuid(1))
    expect(items().map((n) => n.id).sort()).toEqual([uuid(1), uuid(2)])
  })

  it('prunes entries older than 10 s on each mutation', async () => {
    const { service, seed, advance } = setup()
    seed([note(1), note(2)])
    await service.remove(uuid(1))
    advance(10_001)
    await service.remove(uuid(2))
    await rejectsWith(service.restore(uuid(1)), 'NOT_FOUND')
    await service.restore(uuid(2))
  })

  it('a failed write does not leave a restore entry', async () => {
    const { service, seed, write } = setup()
    seed([note(1)])
    write.mockRejectedValueOnce(new Error('EIO'))
    await expect(service.remove(uuid(1))).rejects.toThrow('EIO')
    await rejectsWith(service.restore(uuid(1)), 'NOT_FOUND')
  })

  it('does not lose notes under concurrent creates', async () => {
    const { service, items } = setup()
    await Promise.all(Array.from({ length: 20 }, (_, i) => service.create(`note ${i}`)))
    expect(items()).toHaveLength(20)
    expect(new Set(items().map((n) => n.id)).size).toBe(20)
  })

  it('text(id) returns the current text synchronously', async () => {
    const { service, seed } = setup()
    seed([note(1, { text: 'copy me' })])
    expect(service.text(uuid(1))).toBe('copy me')
  })

  it('a throwing change listener never fails a mutation that was saved', async () => {
    const { service, items, onChange } = setup()
    onChange.mockImplementation(() => {
      throw new Error('listener broke')
    })
    const created = await service.create('kept')
    expect(items()).toEqual([created])
    // later mutations still run
    await expect(service.setPinned(created.id, true)).resolves.toMatchObject({ pinned: true })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('idle() settles once every queued mutation has finished', async () => {
    const { service, write } = setup()
    let release: () => void = () => undefined
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    void service.create('slow')
    let settled = false
    const idle = service.idle().then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await idle
    expect(settled).toBe(true)
  })

  it('idle() resolves even when the last mutation failed', async () => {
    const { service, write } = setup()
    write.mockRejectedValueOnce(new Error('EIO'))
    const failing = service.create('x')
    await expect(service.idle()).resolves.toBeUndefined()
    await expect(failing).rejects.toThrow('EIO')
  })
})
