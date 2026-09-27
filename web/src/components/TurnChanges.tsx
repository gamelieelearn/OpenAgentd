/**
 * TurnChanges — the files a finished turn edited, as a section card.
 *
 * The edits are spread across folded tool rows by the time the turn ends, so
 * this is the one place to see what changed and open it. Deleted files are
 * listed but not openable.
 */
import { useState } from 'react'

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
  if (changes.files.length === 0) return null

  const files = showAll ? changes.files : changes.files.slice(0, VISIBLE_FILES)
  const hidden = changes.files.length - files.length
  const count = changes.files.length

  return (
    <section
      aria-label="Files changed in this turn"
      className="my-2 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)"
    >
      <header className="flex items-center gap-2 border-b border-(--color-border) bg-(--bg-key) px-3 py-1">
        <span className="text-[11px] font-semibold tracking-wider text-(--color-text-muted) uppercase">
          Changed {count} {count === 1 ? 'file' : 'files'}
        </span>
        <LineStats additions={changes.additions} deletions={changes.deletions} />
      </header>
      <ul className="divide-y divide-(--color-border-subtle)">
        {files.map((file) => {
          const { dir, name } = splitPath(file.path)
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
          return (
            <li key={file.path}>
              {onOpenFile && file.kind !== 'delete' ? (
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  aria-label={`Open ${file.path}`}
                  className={`${rowClass} transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)`}
                >
                  {body}
                </button>
              ) : (
                <div className={rowClass}>{body}</div>
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
