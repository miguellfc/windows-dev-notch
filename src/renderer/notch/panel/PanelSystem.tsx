import { useSystem } from '../../shared/system-store'
import { CapsuleMetrics } from '../system/CapsuleMetrics'

/** The system metrics in the panel's header, the same ones the compact capsule shows, as plain figures. */
export function PanelSystem() {
  const view = useSystem((store) => store.capsule.view)
  if (!view) return null
  return (
    <span data-testid="panel-system" className="flex h-7 shrink-0 items-center rounded-control-sm bg-veil pr-2.5">
      <CapsuleMetrics view={view} />
    </span>
  )
}
