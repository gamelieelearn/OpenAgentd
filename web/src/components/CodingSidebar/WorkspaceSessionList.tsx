import { useState } from 'react'
import type React from 'react'
import { ChevronRight, Loader2, Pencil, Trash2 } from 'lucide-react'
import { useCodingWorkspaceSessionsQuery, useSessionSubagentsQuery } from '@/queries/useSessionsQuery'
import type { SessionResponse } from '@/api/types'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function isModifiedPrimaryClick(event: React.MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

/** Inline row action: in-flow (never overlays the title), 24px target. */
const ROW_ACTION =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)'

function WorkspaceSessionRow({
  session,
  isCurrent,
  currentSessionId,
  path,
  mobileLongPressActions,
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionLongPress,
  onSessionContextActions,
}: {
  session: SessionResponse
  isCurrent: boolean
  currentSessionId?: string
  path: string
  mobileLongPressActions: boolean
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.MouseEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, event: React.MouseEvent) => void
}) {
  const needsInput = session.needs_input === true
  const isRunning = session.running === true && !needsInput
  const sessionTitle = session.title || 'Untitled'
  const sessionDate = formatRelativeDate(session.created_at)
  const sessionAge = formatCompactRelative(session.updated_at ?? session.created_at)
  // Touch without long-press sheets has no hover: keep actions visible there.
  const actionsVisibility = mobileLongPressActions
    ? 'hidden'
    : 'hidden group-hover/row:flex group-focus-within/row:flex pointer-coarse:flex'
  const ageVisibility = mobileLongPressActions
    ? ''
    : 'group-hover/row:hidden group-focus-within/row:hidden pointer-coarse:hidden'

  const isChildSessionCurrent = Boolean(
    currentSessionId && session.subagents?.some((s) => s.id === currentSessionId)
  )
  const isTargetSession = isCurrent || currentSessionId === session.id || isChildSessionCurrent
  const { data: subagentsData } = useSessionSubagentsQuery(session.id, isTargetSession)
  const liveMembers = subagentsData?.live_members ?? subagentsData?.subagents
  const subagents = (isTargetSession && liveMembers !== undefined)
    ? liveMembers
    : (session.subagents && session.subagents.length > 0
        ? session.subagents.map((s) => ({
            session_id: s.id,
            member_id: s.agent_name || s.id,
            profile: s.agent_name || 'member',
            title: s.title || s.agent_name || s.id,
            status: s.running ? 'working' : s.needs_input ? 'waiting_lead' : 'completed',
            created_at: s.created_at,
            has_pending_question: s.needs_input === true,
          }))
        : (liveMembers ?? []))

  const hasSubagents = subagents.length > 0
  const isChildActive = subagents.some((sub) => sub.session_id === currentSessionId)
  const hasWaitingSubagent = subagents.some(
    (sub) => sub.status === 'waiting_lead' || sub.has_pending_question
  )
  const hasWorkingSubagent = subagents.some((sub) => sub.status === 'working')
  const hasActiveWork = hasWaitingSubagent || hasWorkingSubagent

  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  const isExpanded =
    isChildActive ||
    (expandedOverride !== null
      ? expandedOverride
      : (isCurrent || hasActiveWork))

  return (
    <div className="space-y-px">
      <div
        className={`group/row flex h-(--spacing-list-row) items-center rounded-sm pr-1 transition-colors duration-(--motion-instant) ${
          isCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'
        }`}
      >
        {hasSubagents ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setExpandedOverride(!isExpanded)
            }}
            className="flex h-6 w-4 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) transition-colors hover:text-(--color-text)"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse ${subagents.length} subagents` : `Expand ${subagents.length} subagents`}
            title={isExpanded ? `Collapse ${subagents.length} subagents` : `Expand ${subagents.length} subagents`}
          >
            <ChevronRight
              size={11}
              className={`shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
        <Tooltip className="w-full">
          <TooltipTrigger
            className="w-full"
            render={
              <LongPressButton
                enabled={mobileLongPressActions}
                onLongPress={() => onSessionLongPress(session)}
                type="button"
                onMouseDown={(e) => {
                  if (!isModifiedPrimaryClick(e)) return
                  onSessionSelect(session, path, e)
                }}
                onClick={(e) => {
                  if (isModifiedPrimaryClick(e)) return
                  onSessionSelect(session, path, e)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onSessionEdit(session)
                }}
                onContextMenu={(e) => {
                  if (mobileLongPressActions) return
                  e.preventDefault()
                  onSessionContextActions(session, e)
                }}
                className={`flex h-(--spacing-list-row) w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors ${
                  isCurrent
                    ? 'text-(--color-text)'
                    : 'text-(--color-text-2) hover:text-(--color-text)'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    needsInput
                      ? 'animate-pulse bg-(--color-warning)'
                      : isRunning
                        ? 'session-title-breathe bg-(--color-accent)'
                        : 'border border-(--color-text-subtle)'
                  }`}
                  aria-label={needsInput ? 'Session needs your input' : isRunning ? 'Session running' : undefined}
                  aria-hidden={needsInput || isRunning ? undefined : true}
                />
                <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold text-(--color-text)' : 'font-medium'} ${isRunning ? 'session-title-breathe text-(--color-text)' : ''}`}>{sessionTitle}</span>
                {hasSubagents && (
                  <span
                    className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-(--bg-key) px-1.5 font-mono text-[11px] leading-4 text-(--color-text-subtle)"
                    aria-label={`${subagents.length} subagent${subagents.length > 1 ? 's' : ''}`}
                  >
                    {!isExpanded && hasActiveWork && (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          hasWaitingSubagent
                            ? 'animate-pulse bg-(--color-warning)'
                            : 'session-title-breathe bg-(--color-accent)'
                        }`}
                        aria-label={hasWaitingSubagent ? 'Subagent waiting for lead' : 'Subagent working'}
                      />
                    )}
                    <span>{subagents.length}</span>
                  </span>
                )}
              </LongPressButton>
            }
          />
          <TooltipContent>{`${sessionTitle} · ${sessionDate}`}</TooltipContent>
        </Tooltip>
        </div>
        {/* Meta slot: the age reads at rest; hover/focus swaps it for the
            row actions in the same place, so neither covers the title. */}
        {sessionAge && (
          <span className={`shrink-0 pl-1 pr-1 text-[11px] tabular-nums text-(--color-text-subtle) ${ageVisibility}`} aria-hidden="true">
            {sessionAge}
          </span>
        )}
        <div className={`shrink-0 items-center ${actionsVisibility}`}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSessionEdit(session)
            }}
            className={ROW_ACTION}
            aria-label={`Edit session ${session.title || 'Untitled'}`}
          >
            <Pencil size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(e) => onSessionDelete(e, session)}
            className={`${ROW_ACTION} hover:bg-(--color-error-subtle) hover:text-(--color-error)`}
            aria-label={`Delete session ${session.title || 'Untitled'}`}
          >
            <Trash2 size={11} aria-hidden="true" />
          </button>
        </div>
      </div>

      {hasSubagents && isExpanded && (
        <div className="ml-[21px] space-y-px border-l border-(--color-border-subtle) py-0.5 pl-1">
          {subagents.map((sub) => {
            const isSubCurrent = sub.session_id === currentSessionId
            const subTitle = sub.title ? sub.title.replace(/^[^:]+:\s*/, '') : sub.member_id
            const isSubWorking = sub.status === 'working'
            const isSubWaiting = sub.status === 'waiting_lead' || sub.has_pending_question
            const subSessionPayload: SessionResponse = {
              id: sub.session_id,
              parent_session_id: session.id,
              title: `${sub.member_id}: ${subTitle}`,
              workspace: session.workspace,
              interaction_mode: 'code',
              running: isSubWorking,
              needs_input: isSubWaiting,
              created_at: sub.created_at ?? null,
              agent_name: sub.member_id,
              updated_at: null,
            }
            return (
              <div key={sub.session_id} className={`group/sub flex h-6 items-center rounded-sm pr-1 ${isSubCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'}`}>
                <Tooltip className="min-w-0 flex-1">
                <TooltipTrigger
                  className="w-full min-w-0"
                  render={
                    <button
                      type="button"
                      onClick={(e) => {
                        onSessionSelect(subSessionPayload, path, e)
                      }}
                      className={`flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors ${
                        isSubCurrent
                          ? 'text-(--color-text) font-semibold'
                          : 'text-(--color-text-2) hover:text-(--color-text)'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          isSubWaiting
                            ? 'animate-pulse bg-(--color-warning)'
                            : isSubWorking
                              ? 'session-title-breathe bg-(--color-accent)'
                              : 'border border-(--color-text-subtle)'
                        }`}
                        aria-label={isSubWaiting ? 'Subagent waiting for lead' : isSubWorking ? 'Subagent working' : undefined}
                      />
                      <span className="shrink-0 font-mono text-[11px] font-semibold text-(--color-text)">
                        {sub.member_id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-(--color-text-muted)">
                        {subTitle}
                      </span>
                    </button>
                  }
                />
                <TooltipContent>
                  {`${sub.member_id}: ${subTitle} · ${
                    isSubWaiting ? 'Waiting for lead decision' : isSubWorking ? 'Working' : 'Completed'
                  }`}
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={(e) => onSessionDelete(e, subSessionPayload)}
                className={`${ROW_ACTION} h-5 w-5 hover:bg-(--color-error-subtle) hover:text-(--color-error) ${mobileLongPressActions ? 'hidden' : 'hidden group-hover/sub:flex group-focus-within/sub:flex pointer-coarse:flex'}`}
                aria-label={`Delete subagent session ${sub.member_id}`}
              >
                <Trash2 size={10} aria-hidden="true" />
              </button>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function WorkspaceSessionList({
  path,
  currentSessionId,
  runningSessions,
  collapsed = false,
  mobileLongPressActions = false,
  className = 'space-y-px py-0.5',
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionLongPress,
  onSessionContextActions,
}: {
  path: string
  currentSessionId?: string
  runningSessions?: SessionResponse[]
  collapsed?: boolean
  mobileLongPressActions?: boolean
  className?: string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.MouseEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, event: React.MouseEvent) => void
}) {
  const sessions = useCodingWorkspaceSessionsQuery(path, !collapsed)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions
  const workspaceSessions = collapsed
    ? (runningSessions ?? [])
    : (sessions.data?.pages.flatMap((page) => page.data) ?? [])

  // Paging is an explicit row rather than an IntersectionObserver inside a
  // nested scroll box: the sidebar keeps a single scroller and every session
  // page is one deliberate click (or Enter) away.
  return (
    <div className={className}>
      {workspaceSessions.length === 0 && !collapsed && !sessions.isLoading && (
        <p className="flex h-6 items-center pl-[22px] text-[11px] text-(--color-text-subtle)">No sessions yet.</p>
      )}
      {workspaceSessions.map((session) => {
        const isCurrent = session.id === currentSessionId
        return (
          <WorkspaceSessionRow
            key={session.id}
            session={session}
            isCurrent={isCurrent}
            currentSessionId={currentSessionId}
            path={path}
            mobileLongPressActions={mobileLongPressActions}
            onSessionSelect={onSessionSelect}
            onSessionDelete={onSessionDelete}
            onSessionEdit={onSessionEdit}
            onSessionLongPress={onSessionLongPress}
            onSessionContextActions={onSessionContextActions}
          />
        )
      })}
      {!collapsed && hasNextPage && (
        <button
          type="button"
          onClick={() => { if (!isFetchingNextPage) void fetchNextPage() }}
          disabled={isFetchingNextPage}
          className="flex h-6 w-full items-center gap-1.5 rounded-sm pl-[22px] text-left text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key)/35 hover:text-(--color-text) disabled:cursor-default"
          aria-label={isFetchingNextPage ? 'Loading more sessions' : 'Show more sessions'}
        >
          {isFetchingNextPage && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          {isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}
