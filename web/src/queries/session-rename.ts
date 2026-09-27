import type { QueryClient } from '@tanstack/react-query'
import { updateSessionTitle } from '@/api/client'
import type { SessionResponse } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import { queryKeys } from './keys'
import { patchSessionInPageData } from './session-cache'

/** Patch every cached copy of a renamed session; the server does not broadcast renames. */
export function applySessionRename(queryClient: QueryClient, updated: SessionResponse): void {
  queryClient.setQueriesData({ queryKey: queryKeys.session.sessions.all() }, (old) => patchSessionInPageData(old, updated))
  queryClient.setQueryData(queryKeys.session.sessions.detail(updated.id), (old: SessionResponse | undefined) => old ? { ...old, ...updated } : old)
  // The header reads the title from the agent store, not the session lists.
  if (useAgentStore.getState().sessionId === updated.id) useAgentStore.setState({ sessionTitle: updated.title })
}

/** Rename outside a component's mutation state (e.g. the chat header). */
export async function renameSession(queryClient: QueryClient, id: string, title: string): Promise<SessionResponse> {
  const updated = await updateSessionTitle(id, title)
  applySessionRename(queryClient, updated)
  return updated
}
