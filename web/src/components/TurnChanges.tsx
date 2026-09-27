/**
 * TurnChanges — the files a finished turn edited, as a section card.
 *
 * The edits are spread across folded tool rows by the time the turn ends, so
 * this is the one place to review them: a row opens that file's diffs from
 * this turn (not the working tree's, which later turns may have moved on),
 * and the header opens them all. Deleted files are listed but not openable.
 */
import { useState } from 'react'
import { ChevronRight, FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileDiffBody } from '@/components/ToolCall/DiffView'
import type { TurnChangeSummary } from '@/components/ToolCall/grouping'

const VISIBLE_FILES = 5

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { dir: '', name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

function LineStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-semibold select-none">
      {additions > 0 && <span className="text-(--color-diff-add-text)">+{additions}</span>}
      {deletions > 0 && <span className="text-(--color-diff-del-text)">-{deletions}</span>}
    </span>
  )
}

export function TurnChanges({ changes, onOpenFile }: {
  changes: TurnChangeSummary
  onOpenFile?: (path: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set())
  if (changes.files.length === 0) return null

  const files = showAll ? changes.files : changes.files.slice(0, VISIBLE_FILES)
  const hidden = changes.files.length - files.length
  const count = changes.files.length
  const reviewable = changes.files.filter((file) => file.kind !== 'delete')
  const allOpen = reviewable.length > 0 && reviewable.every((file) => openPaths.has(file.path))

  const toggleFile = (path: string) => setOpenPaths((prev) => {
    const next = new Set(prev)
    if (!next.delete(path)) next.add(path)
    return next
  })
  const toggleAll = () => {
    if (allOpen) {
      setOpenPaths(new Set())
      return
    }
    setShowAll(true)
    setOpenPaths(new Set(reviewable.map((file) => file.path)))
  }

  return (
    <section
      aria-label="Files changed in this turn"
      className="my-2 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)"
    >
      <button
        type="button"
        onClick={toggleAll}
        disabled={reviewable.length === 0}
        aria-expanded={allOpen}
        className="flex w-full items-center gap-2 border-b border-(--color-border) bg-(--bg-key) px-3 py-1 text-left transition-colors duration-(--motion-instant) enabled:hover:bg-(--bg-key)/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)"
      >
        <span className="text-[11px] font-semibold tracking-wider text-(--color-text-muted) uppercase">
          Changed {count} {count === 1 ? 'file' : 'files'}
        </span>
        <LineStats additions={changes.additions} deletions={changes.deletions} />
      </button>
      <ul className="divide-y divide-(--color-border-subtle)">
        {files.map((file) => {
          const { dir, name } = splitPath(file.path)
          const open = openPaths.has(file.path)
          const body = (
            <>
              <span className="flex min-w-0 font-mono">
                {dir && <span className="min-w-0 truncate text-(--color-text-muted)">{dir}</span>}
                <span className="shrink-0 text-(--color-text)">{name}</span>
              </span>
              {file.kind !== 'update' && (
                <span className="shrink-0 rounded-xs bg-(--bg-key) px-1.5 text-[11px] text-(--color-text-muted)">
                  {file.kind === 'add' ? 'new' : 'deleted'}
                </span>
              )}
              <LineStats additions={file.additions} deletions={file.deletions} />
            </>
          )
          const rowClass = 'flex h-(--spacing-list-row) w-full min-w-0 items-center gap-2 px-3 text-left text-xs'
          if (file.kind === 'delete') {
            return <li key={file.path}><div className={rowClass}>{body}</div></li>
          }
          return (
            <li key={file.path}>
              <div className="flex min-w-0 items-center pr-1">
                <button
                  type="button"
                  onClick={() => toggleFile(file.path)}
                  aria-expanded={open}
                  aria-label={`Changes to ${file.path}`}
                  className={`${rowClass} min-w-0 flex-1 transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)`}
                >
                  {body}
                  <ChevronRight
                    size={12}
                    aria-hidden="true"
                    className={`shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`}
                  />
                </button>
                {onOpenFile && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button variant="ghost" size="icon-xs" onClick={() => onOpenFile(file.path)} aria-label={`Open ${file.path}`}>
                          <FileText aria-hidden="true" />
                        </Button>
                      }
                    />
                    <TooltipContent>Open file</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {open && (
                <div className="max-h-80 touch-pan-y overflow-y-auto overscroll-contain border-t border-(--color-border-subtle) bg-(--bg-input) font-mono text-xs leading-relaxed">
                  {file.diffs.map((diff, index) => (
                    <div key={index} className={index > 0 ? 'border-t border-dashed border-(--color-border)' : undefined}>
                      <FileDiffBody
                        kind={diff.kind}
                        moveTo={diff.moveTo}
                        lines={diff.lines}
                        oldStart={diff.hunkStarts?.[0]?.oldStart ?? 1}
                        newStart={diff.hunkStarts?.[0]?.newStart ?? 1}
                      />
                    </div>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex h-7 w-full items-center border-t border-(--color-border-subtle) px-3 text-left text-[11px] text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)"
        >
          Show {hidden} more {hidden === 1 ? 'file' : 'files'}
        </button>
      )}
    </section>
  )
}
