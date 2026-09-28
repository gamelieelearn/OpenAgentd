/**
 * Reader mode's two additions to a turn (rules in ``segments.ts``): the row
 * standing in for the work, and the list of files the turn edited.
 *
 * The row uses the tool-call row language (mono label, trailing chevron, no
 * card), so the fold reads as one more step. Opened, the steps render as
 * they do in the detailed transcript, on a hairline.
 */
import { useContext, useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import type { ContentBlock } from '@/api/types'
import { cn } from '@/lib/utils'
import { FileRefContext } from '../FileRefLink'
import { FileTypeIcon } from '../FileTypeIcon'
import { formatToolLabel } from '../ToolCall'
import { getToolDisplay } from '../ToolCall/display'
import { ChangeCounts } from '../WorkspacePanel/ChangeCounts'
import type { ChangedFileInfo } from '../WorkspacePanel/diff-helpers'
import { summarizeWork, workSummaryDetail } from './segments'

/** What a running step is doing, as its tool row's tooltip names it. */
function stepLabel(block: ContentBlock): string {
  if (block.type === 'thinking') return 'Thinking'
  const name = block.toolName ?? ''
  const display = getToolDisplay(name, block.toolArgs)
  // A shell call without a description is known by its command.
  const command = name === 'shell' && typeof display.formattedArgs === 'string' ? display.formattedArgs.split('\n', 1)[0] : null
  const detail = display.headerTitle ?? command
  return detail ? `${formatToolLabel(name)}: ${detail}` : formatToolLabel(name)
}

export function WorkSummaryRow({ blocks, live, currentStep, forceOpen = false, children }: {
  /** The folded blocks. */
  blocks: readonly ContentBlock[]
  /** The turn is still open. */
  live: boolean
  /** The step taking output right now, if the turn ends on one. */
  currentStep?: ContentBlock | null
  /** Show the steps whatever the toggle says, e.g. transcript find matched in them. */
  forceOpen?: boolean
  children: ReactNode
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const bodyId = useId()
  const open = forceOpen || manualOpen
  const summary = useMemo(() => summarizeWork(blocks), [blocks])
  const detail = workSummaryDetail(summary)
  const label = live
    ? ['Working', currentStep ? stepLabel(currentStep) : detail].filter(Boolean).join(' · ')
    : detail || (summary.thought ? 'Thought' : 'Worked')

  return (
    <div className="my-2 min-w-0">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group inline-flex max-w-full items-center gap-1.5 py-1 text-left font-mono text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
      >
        <span className={cn('min-w-0 truncate', live && 'animate-pulse motion-reduce:animate-none')}>{label}</span>
        {summary.failed > 0 && <span className="shrink-0 text-(--color-error)">{` · ${summary.failed} failed`}</span>}
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

/** The files a finished turn edited; each opens in the review dock. */
export function TurnChangedFiles({ files }: { files: readonly ChangedFileInfo[] }) {
  const opener = useContext(FileRefContext)
  if (files.length === 0) return null
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const rowClass = 'flex h-(--spacing-list-row) w-full min-w-0 items-center gap-2 px-3 text-left text-xs text-(--color-text-2)'

  return (
    <section aria-label="Files changed this turn" className="my-2 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
      <p className="flex items-center gap-2 border-b border-(--color-border-subtle) px-3 py-1.5 text-xs text-(--color-text-2)">
        <span>{`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`}</span>
        <span className="flex items-center gap-1.5 font-mono text-xs md:text-[11px]">
          {additions > 0 && <span className="text-(--color-diff-add-text)">+{additions}</span>}
          {deletions > 0 && <span className="text-(--color-diff-del-text)">-{deletions}</span>}
        </span>
      </p>
      <ul className="divide-y divide-(--color-border-subtle)">
        {files.map((file) => {
          const content = (
            <>
              <FileTypeIcon name={file.path} size={13} />
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <ChangeCounts file={file} />
            </>
          )
          const ref = { path: file.path }
          return (
            <li key={file.path}>
              {opener && file.status !== 'D' && opener.canOpen(ref) ? (
                <button
                  type="button"
                  title={`Open ${file.path}`}
                  onClick={() => opener.open(ref)}
                  className={cn(rowClass, 'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 hover:text-(--color-text) focus-visible:bg-(--bg-key)/60 focus-visible:outline-none')}
                >
                  {content}
                </button>
              ) : (
                <div className={rowClass}>{content}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
