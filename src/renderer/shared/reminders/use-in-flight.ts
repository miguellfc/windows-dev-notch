import { useState } from 'react'
import { createInFlightGuard, type InFlightGuard } from './in-flight'

/**
 * Per-id in-flight guard for list actions (Snooze, Complete, Delete). A double click on Complete
 * of a repeating reminder would otherwise skip an occurrence. Re-renders when the set changes so
 * rows can disable their buttons.
 */
export function useInFlight(): InFlightGuard {
  const [, setVersion] = useState(0)
  const [guard] = useState(() => createInFlightGuard(() => setVersion((v) => v + 1)))
  return guard
}
