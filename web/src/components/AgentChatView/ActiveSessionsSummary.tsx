import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { activeSessionCounts } from '@/lib/active-sessions'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'

/** "2 running · 1 needs you" across every workspace; hidden when both are zero. */
export function ActiveSessionsSummary({ onClick }: { onClick: () => void }) {
  const { running, needsYou } = activeSessionCounts(useActiveSessionsQuery().data)
  if (running === 0 && needsYou === 0) return null

  const runningLabel = running > 0 ? `${running} running` : null
  const needsYouLabel = needsYou > 0 ? `${needsYou} needs you` : null
  const label = [runningLabel, needsYouLabel].filter(Boolean).join(' · ')

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="mr-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs tabular-nums text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
          >
            {runningLabel && <span>{runningLabel}</span>}
            {runningLabel && needsYouLabel && <span aria-hidden="true">·</span>}
            {needsYouLabel && <span className="text-(--color-warning)">{needsYouLabel}</span>}
          </button>
        }
      />
      <TooltipContent>Show in sidebar</TooltipContent>
    </Tooltip>
  )
}
