/**
 * One assistant turn as reader mode shows it: the final answer alone, or a
 * word on why there is none. The transcript decides which blocks count.
 */
import { useMemo, type ReactNode } from 'react'
import { AssistantTurnFooter } from '@/components/AssistantTurnFooter'
import { PlanActionContext } from '@/utils/markdown-plan'
import type { ContentBlock } from '@/api/types'

function isWork(block: ContentBlock): boolean {
  return block.type === 'text' || block.type === 'thinking' || block.type === 'tool'
}

export interface ReaderTurnProps {
  /** Every block of the turn; the footer reports on all of them. */
  blocks: ContentBlock[]
  /** The blocks reader mode keeps, in turn order. */
  shown: ContentBlock[]
  /** The turn has not ended, so a missing answer may still come. */
  isOpen: boolean
  /** The pending dots already say the agent is working. */
  quiet?: boolean
  renderBlock: (block: ContentBlock) => ReactNode
  onRetry?: () => void
  showModel?: boolean
  onStartImplementing?: () => void
  isSwitchingInteractionMode?: boolean
}

export function ReaderTurn({
  blocks,
  shown,
  isOpen,
  quiet = false,
  renderBlock,
  onRetry,
  showModel,
  onStartImplementing,
  isSwitchingInteractionMode = false,
}: ReaderTurnProps) {
  const planAction = useMemo(
    () => ({ onStartImplementing: isOpen ? undefined : onStartImplementing, isSwitching: isSwitchingInteractionMode }),
    [isOpen, onStartImplementing, isSwitchingInteractionMode],
  )
  const placeholder = isOpen ? (quiet ? null : 'Working…') : 'No written answer'
  // A turn of bookkeeping alone, such as a compaction, had no answer to give.
  if (shown.length === 0 && !blocks.some(isWork)) return null

  return (
    <PlanActionContext.Provider value={planAction}>
      <div className="space-y-[var(--transcript-block-gap,0.5rem)]">
        {shown.length > 0
          ? shown.map((block) => <div key={block.id}>{renderBlock(block)}</div>)
          : placeholder && <p className="text-xs text-(--color-text-subtle) italic">{placeholder}</p>}
        {!isOpen && <AssistantTurnFooter turnBlocks={blocks} size="roomy" onRetry={onRetry} showModel={showModel} />}
      </div>
    </PlanActionContext.Provider>
  )
}
