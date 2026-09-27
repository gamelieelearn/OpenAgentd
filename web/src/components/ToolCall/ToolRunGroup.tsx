/**
 * ToolRunGroup — one summary row standing in for a run of tool calls.
 *
 * Uses the tool-call row language (mono label, trailing chevron, no card) so
 * a folded run reads as "one more step" rather than a new kind of widget.
 * The rows it holds render unchanged once opened, indented on a hairline.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ToolRunSummary } from './grouping'

export function ToolRunGroup({ summary, forceOpen = false, children }: {
  summary: ToolRunSummary
  /** Show the rows whatever the toggle says — e.g. find has a match inside. */
  forceOpen?: boolean
  children: ReactNode
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const bodyId = useId()
  const open = forceOpen || manualOpen

  return (
    <div className="my-2 min-w-0">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group inline-flex max-w-full items-center gap-1.5 py-1 text-left font-mono text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
      >
        <span className="min-w-0 truncate">{summary.label}</span>
        {(summary.additions > 0 || summary.deletions > 0) && (
          <span className="inline-flex shrink-0 items-center gap-1 font-semibold select-none">
            {summary.additions > 0 && <span className="text-(--color-diff-add-text)">+{summary.additions}</span>}
            {summary.deletions > 0 && <span className="text-(--color-diff-del-text)">-{summary.deletions}</span>}
          </span>
        )}
        {summary.failed > 0 && (
          <span className="shrink-0 text-(--color-error)">· {summary.failed} failed</span>
        )}
        <ChevronRight
          size={13}
          aria-hidden
          className={cn('shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div id={bodyId} className="ml-1 min-w-0 border-l border-(--color-border) pl-3">
          {children}
        </div>
      )}
    </div>
  )
}
