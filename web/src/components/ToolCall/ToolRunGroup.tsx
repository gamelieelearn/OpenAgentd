/**
 * ToolRunGroup — one "Explored · …" row standing in for a run of read-only
 * tool calls.
 *
 * Uses the tool-call row language (mono label, trailing chevron, no card) so
 * a folded run reads as "one more step" rather than a new kind of widget.
 * The rows it holds render unchanged once opened, indented on a hairline.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ToolRunSummary } from './grouping'

export function ToolRunGroup({ summary, children }: { summary: ToolRunSummary; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    <div className="my-2 min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group inline-flex max-w-full items-center gap-1.5 py-1 text-left font-mono text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
      >
        <span className="min-w-0 truncate">{summary.label}</span>
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
