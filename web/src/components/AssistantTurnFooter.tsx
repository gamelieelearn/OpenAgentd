/**
 * Footer rendered at the bottom of a completed assistant turn, plus the
 * `AssistantTurn` wrapper that groups a turn's blocks and decides when to
 * show the footer.
 *
 * Used by both the compact pane (split / unified) and the wide single-agent
 * view. Each view passes its own `renderBlock` so the per-view block visuals
 * (e.g. compact vs roomy `UserBubble`) stay independent.
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Copy, Check } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTime, formatFullDateTime, lastTurnText, shortModelName } from '@/utils/format'
import { formatCompact, formatInt, formatSpend } from '@/utils/telemetryFormat'
import { PlanActionContext } from '@/utils/markdown-plan'
import type { ContentBlock } from '@/api/types'
import { TurnChangedFiles, WorkSummaryRow } from '@/components/ReaderTurn'
import { readerSegments, turnChangedFiles } from '@/components/ReaderTurn/segments'

export interface AssistantTurnFooterProps {
  /** Blocks belonging to a single assistant turn (no user blocks inside). */
  turnBlocks: ContentBlock[]
  /** Visual density: 'compact' for narrow panes, 'roomy' for the wide view. */
  size?: 'compact' | 'roomy'
  /** Name the model; the transcript does so only when it changed. */
  showModel?: boolean
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

export const AssistantTurnFooter = memo(function AssistantTurnFooter({ turnBlocks, size = 'compact', showModel = true }: AssistantTurnFooterProps) {
  const [copied, setCopied] = useState(false)
  const footerData = useMemo(() => {
    // Me lastTurnText walks back to the previous user block; pass the turn directly
    const textContent = lastTurnText(turnBlocks)
    const lastBlock = turnBlocks[turnBlocks.length - 1]
    let responseDurationMs: number | undefined
    let modelId: string | undefined
    let hasTool = false
    let outputTokens = 0
    let costUsd = 0
    for (const block of turnBlocks) {
      outputTokens += block.usage?.outputTokens ?? 0
      costUsd += block.usage?.costUsd ?? 0
    }
    for (let i = turnBlocks.length - 1; i >= 0; i--) {
      const block = turnBlocks[i]
      responseDurationMs ??= typeof block.responseDurationMs === 'number'
        ? block.responseDurationMs
        : undefined
      modelId ??= typeof block.extra?.model === 'string' ? block.extra.model : undefined
      hasTool ||= block.type === 'tool'
      if (responseDurationMs !== undefined && modelId !== undefined && hasTool) break
    }
    return {
      textContent,
      timestamp: lastBlock?.timestamp,
      responseDurationMs,
      modelId,
      modelName: shortModelName(modelId),
      hasTool,
      outputTokens,
      costUsd: Math.round(costUsd * 1e8) / 1e8,
    }
  }, [turnBlocks])
  const { textContent, timestamp, responseDurationMs, modelName, outputTokens, costUsd } = footerData

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }, [textContent])

  if (!textContent && !timestamp && responseDurationMs === undefined && !modelName) return null

  const wrapperClass = size === 'roomy' ? 'mt-1 flex items-center gap-1.5' : 'mt-0.5 flex items-center gap-1'
  const iconSize = size === 'roomy' ? 11 : 10

  return (
    <div className={wrapperClass}>
      {textContent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={handleCopy}
                className="rounded-sm p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 active:scale-90"
                aria-label="Copy response"
              >
                {copied
                  ? <Check size={iconSize} className="text-(--color-success)" />
                  : <Copy size={iconSize} />}
              </button>
            }
          />
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>
      )}
      {showModel && modelName && (
        <span data-turn-model className="font-mono text-[11px] text-(--color-text-muted)">{modelName}</span>
      )}
      {timestamp && (
        <Tooltip className="text-[11px] text-(--color-text-muted)">
          <TooltipTrigger render={<span className="text-[11px] text-(--color-text-muted)">{formatTime(timestamp)}</span>} />
          <TooltipContent>{formatFullDateTime(timestamp)}</TooltipContent>
        </Tooltip>
      )}
      {responseDurationMs !== undefined && (
        <span className="font-mono text-[11px] text-(--color-text-muted)">{formatDuration(responseDurationMs)}</span>
      )}
      {(outputTokens > 0 || costUsd > 0) && (
        <span
          className="font-mono text-[11px] text-(--color-text-muted)"
          aria-label={`${formatInt(outputTokens)} output tokens${costUsd > 0 ? `, $${costUsd.toFixed(4)}` : ''}`}
          title={`${formatInt(outputTokens)} output tokens${costUsd > 0 ? ` · $${costUsd.toFixed(4)}` : ''}`}
        >
          {costUsd > 0 ? formatSpend(costUsd) : `${formatCompact(outputTokens)} tok`}
        </span>
      )}
    </div>
  )
})

export interface AssistantTurnProps {
  /** Blocks belonging to this turn (no user blocks inside). */
  blocks: ContentBlock[]
  /** Absolute index of `blocks[0]` in the parent's full block list. */
  startIndex: number
  /** Number of finalized blocks (i.e. `stream.blocks.length`); blocks at or
   *  past this index are still in-flight when `isWorking` is true. */
  finalizedCount: number
  /** True while the agent is actively streaming. Drives the per-block cursor. */
  isWorking: boolean
  /**
   * True while this pane's turn has not ended — a superset of ``isWorking``
   * that also covers a lead suspended on ``ask_user``, where nothing streams
   * but the turn is still open.
   *
   * Kept separate from ``isWorking`` because the two answer different
   * questions: ``isWorking`` decides whether a *block* is mid-stream, this
   * decides whether the *turn* is over.
   * Defaults to ``isWorking`` for callers with no suspendable turn.
   */
  isTurnOpen?: boolean
  /** True when this turn has no user block after it (i.e. trailing). Only
   *  trailing turns can be "live"; any turn followed by a user message is
   *  finalized regardless of `isWorking`. */
  isTrailingTurn: boolean
  /** Total length of the parent's full block list (for `isLast` cursor). */
  totalBlocks: number
  /** Per-view block renderer. */
  renderBlock: (args: { block: ContentBlock; isStreaming: boolean; isLast: boolean }) => ReactNode
  /** Footer density. */
  size?: 'compact' | 'roomy'
  /** Callback to switch to Code mode and start implementation of a proposed plan. */
  onStartImplementing?: () => void
  /** True when interaction mode is actively transitioning to Code mode. */
  isSwitchingInteractionMode?: boolean
  /** Passed to the footer. */
  showModel?: boolean
  /**
   * Reader mode: the work folds behind one summary row, and a finished
   * turn lists the files it edited (see ``ReaderTurn/segments.ts``).
   */
  reader?: boolean
  /** Blocks transcript find matched; a fold holding one opens. */
  findHitBlockIds?: ReadonlySet<string>
}

export const AssistantTurn = memo(function AssistantTurn({
  blocks,
  startIndex,
  finalizedCount,
  isWorking,
  isTurnOpen = isWorking,
  isTrailingTurn,
  totalBlocks,
  renderBlock,
  size = 'compact',
  onStartImplementing,
  isSwitchingInteractionMode = false,
  showModel,
  reader = false,
  findHitBlockIds,
}: AssistantTurnProps) {
  // The footer reports on a *finished* turn, so it waits for the turn to close
  // rather than merely for the stream to stop.
  const turnIsOpen = isTurnOpen && isTrailingTurn
  const planActionValue = useMemo(
    () => ({
      onStartImplementing: !turnIsOpen ? onStartImplementing : undefined,
      isSwitching: isSwitchingInteractionMode,
    }),
    [turnIsOpen, onStartImplementing, isSwitchingInteractionMode],
  )
  const segments = useMemo(() => (reader ? readerSegments(blocks) : null), [reader, blocks])
  const changedFiles = useMemo(() => (reader && !turnIsOpen ? turnChangedFiles(blocks) : []), [reader, turnIsOpen, blocks])

  const renderAt = (j: number) => {
    const block = blocks[j]
    const absoluteIdx = startIndex + j
    const isLast = absoluteIdx === totalBlocks - 1
    // Only the block currently receiving output is streaming. Earlier
    // blocks of the same turn are finished the moment the next one opens —
    // flagging them too gave every one of them a typewriter rAF loop with
    // nothing to animate. `appendStreamed` only ever fills the last block
    // of a kind, so the block taking deltas is always the trailing one.
    // Compaction blocks live in `blocks` directly, so their active streaming
    // state is indicated by `block.extra?.state === 'compacting'`.
    const isCompactionStreaming = isWorking && block.type === 'compaction' && block.extra?.state === 'compacting'
    const isStreaming = isCompactionStreaming || (isWorking && absoluteIdx >= finalizedCount && isLast)
    return (
      <div key={block.id}>
        {renderBlock({
          block,
          isStreaming,
          isLast,
        })}
      </div>
    )
  }

  return (
    <PlanActionContext.Provider value={planActionValue}>
      <div className="space-y-2">
      {segments
        ? segments.map((segment) => {
            if (segment.kind === 'block') return renderAt(segment.index)
            const work = segment.indices.map((j) => blocks[j])
            const lastIndex = segment.indices[segment.indices.length - 1]
            return (
              <WorkSummaryRow
                // Keyed by its first block so the toggle survives new steps.
                key={`work-${work[0].id}`}
                blocks={work}
                live={turnIsOpen}
                currentStep={turnIsOpen && lastIndex === blocks.length - 1 ? blocks[lastIndex] : null}
                forceOpen={work.some((block) => findHitBlockIds?.has(block.id) ?? false)}
              >
                {segment.indices.map(renderAt)}
              </WorkSummaryRow>
            )
          })
        : blocks.map((_, j) => renderAt(j))}
      {changedFiles.length > 0 && <TurnChangedFiles files={changedFiles} />}
      {!turnIsOpen && <AssistantTurnFooter turnBlocks={blocks} size={size} showModel={showModel} />}
    </div>
    </PlanActionContext.Provider>
  )
})
