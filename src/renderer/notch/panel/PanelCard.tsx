import type { LucideIcon } from 'lucide-react'
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { IntegrationKey } from '../../../shared/integrations/colors'
import { integrationStyle, useIntegration } from '../../shared/integration-color'

/** Whether this card holds the row's single Tab stop (the row moves it with the arrow keys). */
export const CardTabStop = createContext(true)

/** The integration's color at 8 % on top, gone by half the card's height. */
const VEIL: CSSProperties = {
  background: 'linear-gradient(to bottom, color-mix(in srgb, var(--int) 8%, transparent), transparent 50%)',
}

export interface PanelCardProps {
  cardKey: IntegrationKey
  title: string
  icon: LucideIcon
  testId: string
  labelTestId: string
  onOpen: () => void
  /** The coral count beside the title, and how a screen reader says it. */
  badge?: { count: number; label: string } | undefined
  children?: ReactNode
}

/**
 * One card of the row. It is a container, not a button: the main button covers it and the content
 * sits above without taking the pointer, so a control inside (`pointer-events-auto`) never nests in
 * another button.
 */
export function PanelCard({ cardKey, title, icon: Icon, testId, labelTestId, onOpen, badge, children }: PanelCardProps) {
  const { color } = useIntegration(cardKey)
  const isTabStop = useContext(CardTabStop)
  return (
    <div data-testid={testId} style={integrationStyle(color)} className="card relative h-[196px] w-[172px] overflow-hidden">
      <span aria-hidden="true" className="pointer-events-none absolute inset-0" style={VEIL} />
      <button
        type="button"
        data-card-main
        tabIndex={isTabStop ? 0 : -1}
        aria-label={badge ? `${title}, ${badge.label}` : title}
        onClick={onOpen}
        className="focus-inset absolute inset-0 cursor-pointer rounded-card transition-colors duration-150 hover:bg-veil"
      />
      <div className="pointer-events-none relative flex h-full flex-col p-3">
        <div aria-hidden="true" className="flex h-5 shrink-0 items-center gap-1.5">
          <Icon size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[color:var(--int)]" />
          <span data-testid={labelTestId} className="min-w-0 flex-1 truncate text-small font-medium text-chalk">
            {title}
          </span>
          {badge && (
            <span
              data-testid={`${testId}-badge`}
              className="tabular flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-wait px-1 text-label font-semibold leading-none text-on-wait"
            >
              {badge.count > 99 ? '99+' : badge.count}
            </span>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}
