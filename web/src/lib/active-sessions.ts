import type { InfiniteData } from '@tanstack/react-query'
import type { SessionPageResponse, SessionResponse } from '@/api/types'

/**
 * Sessions waiting on the user, from ``useActiveSessionsQuery`` data.
 * Filtered here rather than trusted: an older server ignores ``active`` and
 * answers with a normal page of sessions.
 */
export function needsYouSessions(data: InfiniteData<SessionPageResponse> | undefined): SessionResponse[] {
  return (data?.pages.flatMap((page) => page.data) ?? []).filter(
    (session) => session.needs_input === true && !session.parent_session_id && Boolean(session.workspace),
  )
}
