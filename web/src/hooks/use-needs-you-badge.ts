import { useEffect } from 'react'
import { needsYouSessions } from '@/lib/active-sessions'
import { syncDesktopBadgeCount } from '@/lib/window-title'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'

/** How many sessions wait on the user, mirrored onto the app icon badge. */
export function useNeedsYouBadge(): number {
  const count = needsYouSessions(useActiveSessionsQuery().data).length
  useEffect(() => {
    void syncDesktopBadgeCount(count)
  }, [count])
  return count
}
