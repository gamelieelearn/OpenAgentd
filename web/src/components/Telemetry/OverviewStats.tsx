/**
 * Headline strip: the numbers a user checks first. Spend, turns (and how
 * many failed), typical turn time, how fast models start answering and
 * stream, token volume, and how much of the prompt came from cache (the
 * main cost lever).
 */
import { cn } from '@/lib/utils'
import { formatCompact, formatMs, formatPercent, formatSpend, formatTps } from '@/utils/telemetryFormat'
import type { Headline } from './model'

function Stat({
  label,
  value,
  detail,
  detailTone = 'muted',
  className,
}: {
  label: string
  value: string
  detail: string
  detailTone?: 'muted' | 'error'
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 bg-(--bg-card) px-3 py-2.5', className)}>
      <dt className="text-[11px] text-(--color-text-muted)">{label}</dt>
      <dd className="truncate font-mono text-lg font-semibold tabular-nums text-(--color-text)">{value}</dd>
      <dd className={cn('truncate text-[11px]', detailTone === 'error' ? 'text-(--color-error)' : 'text-(--color-text-subtle)')}>
        {detail}
      </dd>
    </div>
  )
}

export function OverviewStats({ data }: { data: Headline }) {
  return (
    <dl
      aria-label="Overview"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) bg-(--color-border) md:grid-cols-4 lg:grid-cols-7"
    >
      <Stat
        label="Spend"
        value={formatSpend(data.spend)}
        detail={data.turns > 0 ? `${formatSpend(data.spendPerTurn)} per turn` : 'Estimated from model pricing'}
        // Seven cells: the lead stat spans a row so the two- and four-column
        // grids fill evenly.
        className="col-span-2 lg:col-span-1"
      />
      <Stat
        label="Turns"
        value={formatCompact(data.turns)}
        detail={data.failedTurns > 0 ? `${formatCompact(data.failedTurns)} failed` : 'None failed'}
        detailTone={data.failedTurns > 0 ? 'error' : 'muted'}
      />
      <Stat label="Median turn" value={formatMs(data.turnP50)} detail={`p95 ${formatMs(data.turnP95)}`} />
      <Stat
        label="First token"
        value={formatMs(data.ttftP50)}
        detail={data.ttftP50 > 0 ? `p95 ${formatMs(data.ttftP95)}` : 'Not measured in this range'}
      />
      <Stat
        label="Output speed"
        value={formatTps(data.tpsP50)}
        detail={data.tpsP50 > 0 ? `5% under ${formatTps(data.tpsP5)}` : 'Not measured in this range'}
      />
      <Stat
        label="Tokens"
        value={formatCompact(data.inputTokens + data.outputTokens)}
        detail={`${formatCompact(data.inputTokens)} in, ${formatCompact(data.outputTokens)} out`}
      />
      <Stat
        label="Cache hit"
        value={formatPercent(data.cachePercent)}
        detail={`${formatCompact(data.cachedTokens)} tokens from cache`}
      />
    </dl>
  )
}
