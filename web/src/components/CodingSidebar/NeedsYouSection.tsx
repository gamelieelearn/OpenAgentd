import type React from 'react'
import type { SessionResponse } from '@/api/types'
import { needsYouSessions } from '@/lib/active-sessions'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'
import { SessionStatusMark } from './SessionStatusMark'

/** Sessions stopped on a question, from every workspace, above the tree. */
export function NeedsYouSection({
  currentSessionId,
  workspaceName,
  onSessionSelect,
}: {
  currentSessionId?: string
  workspaceName: (path: string) => string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
}) {
  const { data } = useActiveSessionsQuery()
  const sessions = needsYouSessions(data)
  if (sessions.length === 0) return null

  return (
    <section aria-label="Needs you" className="shrink-0 border-b border-(--color-border-subtle) pb-1.5">
      <div className="flex h-8 items-center gap-1.5 pl-3 pr-1.5 text-[11px] leading-none">
        <span className="font-semibold uppercase tracking-[0.05em] text-(--color-text-subtle)">Needs you</span>
        <span className="tabular-nums text-(--color-warning)">{sessions.length}</span>
      </div>
      <ul className="max-h-48 space-y-px overflow-y-auto px-1.5">
        {sessions.map((session) => {
          const isCurrent = session.id === currentSessionId
          const workspace = session.workspace ?? ''
          return (
            <li key={session.id}>
              <button
                type="button"
                onClick={(event) => onSessionSelect(session, workspace, event)}
                aria-current={isCurrent ? 'page' : undefined}
                className={`flex h-(--spacing-list-row) w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs text-(--color-text) transition-colors ${
                  isCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'
                }`}
              >
                <SessionStatusMark status="needs_input" />
                <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold' : 'font-medium'}`}>
                  {session.title || 'Untitled'}
                </span>
                <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-(--color-text-subtle)">
                  {workspaceName(workspace)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
