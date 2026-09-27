import type React from 'react'
import type { SessionResponse } from '@/api/types'
import { SessionStatusMark, type SessionStatus } from './SessionStatusMark'

/** A session outside the tree (Needs you, search results): status, title, workspace. */
export function CompactSessionRow({
  session,
  status,
  isCurrent,
  workspaceName,
  onSelect,
}: {
  session: SessionResponse
  status: SessionStatus
  isCurrent: boolean
  workspaceName: string
  onSelect: (event: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isCurrent ? 'page' : undefined}
      className={`flex h-(--spacing-list-row) w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors ${
        isCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'
      } ${isCurrent || status !== 'idle' ? 'text-(--color-text)' : 'text-(--color-text-2) hover:text-(--color-text)'}`}
    >
      <SessionStatusMark status={status} />
      <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold' : 'font-medium'}`}>
        {session.title || 'Untitled'}
      </span>
      <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-(--color-text-subtle)">
        {workspaceName}
      </span>
    </button>
  )
}
