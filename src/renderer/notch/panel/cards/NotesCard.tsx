import { useNotes } from '../../../shared/notes-store'
import { noteLabel } from '../../../shared/notes/format'
import { useT } from '../../../shared/use-t'
import { CardNotice } from './CardNotice'
import { topNotes } from './card-content'

/** Three notes, a line each: pinned first, then the latest edited. */
export function NotesCard() {
  const t = useT()
  const notes = useNotes((store) => store.notes)
  if (notes === null) return <CardNotice text={t('panel.card.loading')} />
  if (notes.length === 0) return <CardNotice text={t('notes.list.empty')} />
  return (
    <ul className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {topNotes(notes).map((note) => (
        <li key={note.id} className="truncate text-small text-chalk">
          {noteLabel(note.text)}
        </li>
      ))}
    </ul>
  )
}
