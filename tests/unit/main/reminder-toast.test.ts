import { describe, expect, it, vi } from 'vitest'
import { createReminderToast, type ReminderToastRequest } from '../../../src/main/reminders/reminder-toast'
import { translate } from '../../../src/shared/i18n/messages'
import type { Language } from '../../../src/shared/settings/schema'
import type { Reminder } from '../../../src/shared/reminders/schema'

const reminder = (n: number, text: string): Reminder => ({
  id: `3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7${n}`,
  text,
  dueAt: '2026-11-10T10:00:00.000Z',
  repeat: 'none',
  state: 'due',
  createdAt: '2026-11-10T09:00:00.000Z',
})

function setup(language: Language = 'es') {
  const notify = vi.fn<(request: ReminderToastRequest) => void>()
  const onClick = vi.fn()
  const toast = createReminderToast({
    notify,
    translate: (key, params) => translate(language, key, params),
    onClick,
  })
  const last = () => notify.mock.calls.at(-1)![0]
  return { notify, onClick, toast, last }
}

describe('createReminderToast', () => {
  it('shows a single reminder with its text as the body', () => {
    const { toast, last, notify } = setup('es')
    toast.fired([reminder(1, 'Revisar PR')])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(last()).toMatchObject({ title: 'Recordatorio', body: 'Revisar PR', silent: true })
  })

  it('groups several reminders into one toast with the first two texts', () => {
    const { toast, last, notify } = setup('es')
    toast.fired([reminder(1, 'Revisar PR'), reminder(2, 'Llamar a Ana'), reminder(3, 'Desplegar')])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(last()).toMatchObject({ title: '3 recordatorios', body: 'Revisar PR · Llamar a Ana', silent: true })
    expect(last().body).not.toContain('Desplegar')
  })

  it('uses the current language', () => {
    const { toast, last } = setup('en')
    toast.fired([reminder(1, 'Review PR')])
    expect(last()).toMatchObject({ title: 'Reminder', body: 'Review PR' })
    toast.fired([reminder(1, 'Review PR'), reminder(2, 'Call Ana')])
    expect(last()).toMatchObject({ title: '2 reminders', body: 'Review PR · Call Ana' })
  })

  it('summarizes missed reminders by count only', () => {
    const es = setup('es')
    es.toast.missed(4)
    expect(es.last()).toMatchObject({ title: 'Recordatorios perdidos', body: 'Tienes 4 recordatorios perdidos', silent: true })

    const en = setup('en')
    en.toast.missed(4)
    expect(en.last()).toMatchObject({ title: 'Missed reminders', body: 'You have 4 missed reminders' })
    en.toast.missed(1)
    expect(en.last().body).toBe('You have 1 missed reminder')
  })

  it('has no buttons (plan B): the toast only carries title, body, silent and the click', () => {
    const { toast, last } = setup()
    toast.fired([reminder(1, 'Revisar PR')])
    expect(Object.keys(last()).sort()).toEqual(['body', 'onClick', 'silent', 'title'])
  })

  it('does nothing for an empty batch or zero missed', () => {
    const { toast, notify } = setup()
    toast.fired([])
    toast.missed(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('clicking the body runs the open callback', () => {
    const { toast, last, onClick } = setup()
    toast.fired([reminder(1, 'Revisar PR')])
    expect(onClick).not.toHaveBeenCalled()
    last().onClick()
    expect(onClick).toHaveBeenCalledTimes(1)
    toast.missed(2)
    last().onClick()
    expect(onClick).toHaveBeenCalledTimes(2)
  })
})
