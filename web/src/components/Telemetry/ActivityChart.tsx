/**
 * Per-day activity: spend or turns as a bar series over the selected window.
 * Failed turns stack at the base of each turns bar in the error tone. Days
 * with no activity keep their slot so gaps read as gaps.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatCompact, formatSpend } from '@/utils/telemetryFormat'
import type { DayPoint } from './model'

type Metric = 'spend' | 'turns'

const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? day : dayFmt.format(date)
}

function barLabel(point: DayPoint): string {
  const failed = point.failed > 0 ? `, ${point.failed} failed` : ''
  return `${dayLabel(point.day)}: ${formatSpend(point.cost)}, ${point.turns} ${point.turns === 1 ? 'turn' : 'turns'}${failed}`
}

export function ActivityChart({ points, hasCost }: { points: DayPoint[]; hasCost: boolean }) {
  const [chosen, setChosen] = useState<Metric>('spend')
  // Older backends report no per-day cost; fall back to turns.
  const metric: Metric = hasCost ? chosen : 'turns'
  const value = (p: DayPoint) => (metric === 'spend' ? p.cost : p.turns)
  const max = Math.max(0, ...points.map(value))
  const peak = metric === 'spend' ? formatSpend(max) : `${formatCompact(max)} turns`
  // Roving tab stop: the chart is one Tab stop (a 90-day range would
  // otherwise add 90); arrow keys walk the days and focus shows the tooltip.
  const listRef = useRef<HTMLDivElement>(null)
  const [focusDay, setFocusDay] = useState<string | null>(null)
  const focusFound = focusDay === null ? -1 : points.findIndex((p) => p.day === focusDay)
  const focusIndex = focusFound >= 0 ? focusFound : points.length - 1
  const moveFocus = (index: number) => {
    const next = Math.min(points.length - 1, Math.max(0, index))
    if (!points[next]) return
    setFocusDay(points[next].day)
    listRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]')[next]?.focus()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = { ArrowLeft: focusIndex - 1, ArrowRight: focusIndex + 1, Home: 0, End: points.length - 1 }[event.key]
    if (target === undefined) return
    event.preventDefault()
    moveFocus(target)
  }

  return (
    <SectionCard>
      <SectionCardHeader className="flex items-center justify-between gap-2 py-1">
        <span>Activity</span>
        {hasCost && (
          <div role="radiogroup" aria-label="Chart metric" className="flex items-center gap-0.5 normal-case tracking-normal">
            {(['spend', 'turns'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={metric === m}
                onClick={() => setChosen(m)}
                className={cn(
                  'h-6 rounded-xs border px-2 text-[11px] font-medium transition-colors duration-(--motion-instant)',
                  metric === m
                    ? 'border-(--color-border-strong) bg-(--bg-card) text-(--color-text)'
                    : 'border-transparent text-(--color-text-muted) hover:text-(--color-text-2)',
                )}
              >
                {m === 'spend' ? 'Spend' : 'Turns'}
              </button>
            ))}
          </div>
        )}
      </SectionCardHeader>
      <div className="px-3 pt-2 pb-2.5">
        <div className="mb-1 flex items-baseline justify-between text-[11px] text-(--color-text-subtle)">
          <span>
            Peak <span className="font-mono text-(--color-text-muted)">{peak}</span>
          </span>
          {metric === 'turns' && points.some((p) => p.failed > 0) && (
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="h-2 w-2 rounded-xs bg-(--color-error)/70" />
              Failed
            </span>
          )}
        </div>
        <div
          ref={listRef}
          role="list"
          aria-label={metric === 'spend' ? 'Spend per day' : 'Turns per day'}
          className="flex h-28 items-end gap-px border-b border-(--color-border-subtle)"
          onKeyDown={handleKeyDown}
        >
          {points.map((point, index) => {
            const v = value(point)
            const height = max > 0 && v > 0 ? Math.max(2, (v / max) * 100) : 0
            const failedShare = metric === 'turns' && point.turns > 0 ? (point.failed / point.turns) * 100 : 0
            return (
              <Tooltip key={point.day} className="flex h-full min-w-0 flex-1 items-end">
                <TooltipTrigger
                  className="flex h-full min-w-0 flex-1 items-end"
                  render={
                    <div
                      role="listitem"
                      aria-label={barLabel(point)}
                      tabIndex={index === focusIndex ? 0 : -1}
                      onFocus={() => setFocusDay(point.day)}
                      className="group flex h-full min-w-0 flex-1 items-end rounded-t-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                    >
                      <div
                        className="flex w-full flex-col-reverse overflow-hidden rounded-t-xs bg-(--color-text-subtle)/45 transition-colors duration-(--motion-instant) group-hover:bg-(--color-accent)/70 group-focus-visible:bg-(--color-accent)/70"
                        style={{ height: `${height}%` }}
                      >
                        {failedShare > 0 && <div className="w-full bg-(--color-error)/70" style={{ height: `${failedShare}%` }} />}
                      </div>
                    </div>
                  }
                />
                <TooltipContent>{barLabel(point)}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        {points.length > 0 && (
          <div className="mt-1 flex justify-between font-mono text-[11px] text-(--color-text-subtle)">
            <span>{dayLabel(points[0].day)}</span>
            {points.length > 1 && <span>{dayLabel(points[points.length - 1].day)}</span>}
          </div>
        )}
      </div>
    </SectionCard>
  )
}
