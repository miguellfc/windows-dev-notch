import type { CSSProperties } from 'react'
import type { IntegrationColor } from '../../shared/integrations/colors'

/** Sets `--int` (read by contribution grids, rings, sparklines…) to a palette colour. Pure, so it is testable under the node tsconfig. */
export function integrationStyle(color: IntegrationColor): CSSProperties {
  return { '--int': `var(--color-int-${color})` } as CSSProperties
}
