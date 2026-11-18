import type { MessageKey } from '../../../shared/i18n/messages'
import { Kbd } from '../../ui/Kbd'
import { useT } from '../../shared/use-t'

function Hint({ keys, spoken, label }: { keys: string; spoken: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="sr-only">{spoken} </span>
      <Kbd accelerator={keys} size="sm" />
      {label}
    </span>
  )
}

/**
 * The panel's keys, in one centred line. When an app fails to open, the notice takes its place for
 * its 4 s; the notice stays mounted (empty) so screen readers announce it when it fills.
 */
export function HelpLine({ failed }: { failed: MessageKey | null }) {
  const t = useT()
  return (
    <div className="relative mt-2 h-5 shrink-0 text-label text-graphite">
      <p role="status" data-testid="apps-open-failed" className="absolute inset-0 truncate text-center leading-5">
        {failed !== null ? t('apps.openFailed', { app: t(failed) }) : ''}
      </p>
      {failed === null && (
        <div data-testid="panel-help" className="absolute inset-0 flex items-center justify-center gap-2">
          <Hint keys="Esc" spoken="Esc" label={t('hint.close')} />
          <span aria-hidden="true">·</span>
          <Hint keys="←→" spoken="← →" label={t('hint.cards')} />
          <span aria-hidden="true">·</span>
          <Hint keys="Enter" spoken="Enter" label={t('hint.open')} />
        </div>
      )}
    </div>
  )
}
