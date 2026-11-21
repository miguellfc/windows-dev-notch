import type { CSSProperties } from 'react'
import { isPaletteColor, type IntegrationColor } from '../../shared/integrations/colors'

/**
 * Sets `--int` (read by contribution grids, rings, sparklines…) to the integration's colour: the
 * palette token for a palette id, the hex itself for a custom colour. Pure, so it is testable
 * under the node tsconfig.
 */
export function integrationStyle(color: IntegrationColor): CSSProperties {
  return { '--int': isPaletteColor(color) ? `var(--color-int-${color})` : color } as CSSProperties
}
