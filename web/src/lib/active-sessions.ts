import type { InfiniteData } from '@tanstack/react-query'
import type { SessionPageResponse, SessionResponse } from '@/api/types'

/**
 * Sessions waiting on the user, from ``useActiveSessionsQuery`` data.
 * Filtered here rather than trusted: an older server ignores ``active`` and
 * answers with a normal page of sessions.
 */
export function needsYouSessions(data: InfiniteData<SessionPageResponse> | undefined): SessionResponse[] {
  return topLevelSessions(data).filter((session) => session.needs_input === true)
}

/** Header summary counts: sessions still working, and those waiting on the user. */
export function activeSessionCounts(data: InfiniteData<SessionPageResponse> | undefined): { running: number; needsYou: number } {
  const sessions = topLevelSessions(data)
  return {
    running: sessions.filter((session) => session.running === true && session.needs_input !== true).length,
    needsYou: sessions.filter((session) => session.needs_input === true).length,
  }
}

function topLevelSessions(data: InfiniteData<SessionPageResponse> | undefined): SessionResponse[] {
  return (data?.pages.flatMap((page) => page.data) ?? []).filter(
    (session) => !session.parent_session_id && Boolean(session.workspace),
  )
}
