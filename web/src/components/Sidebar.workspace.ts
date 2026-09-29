import type { QueryClient } from '@tanstack/react-query'
import type { SessionResolveResponse } from '@/api/types'
import { resolveSession, setCodingWorkspaceVisibility } from '@/api/client'
import { queryKeys } from '@/queries'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { useAgentStore } from '@/stores/useAgentStore'
import { removeWorkspace, saveLastWorkspace } from '@/utils/workspace'

export async function openWorkspaceSession(options: {
  path: string
  requestedCreate: boolean
  currentSessionId?: string
  currentWorkspace?: string | null
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: string; params: { sessionId: string } }) => void
  resolveSessionFn?: typeof resolveSession
}): Promise<{ skipped: boolean }> {
  const state = useAgentStore.getState()
  const create = options.requestedCreate && !(
    state.isEmptyIdleSession() &&
    state.sessionId === options.currentSessionId &&
    options.currentWorkspace === options.path
  )
  if (options.requestedCreate && !create) return { skipped: true }

  saveLastWorkspace(options.path)
  state.beginResolvedSession(null, {
    workspace: options.path,
    model: state.sessionModel,
    thinkingLevel: state.sessionThinkingLevel,
  })
  const session = await (options.resolveSessionFn ?? resolveSession)({
    workspace: options.path,
    model: state.sessionModel,
    thinkingLevel: state.sessionThinkingLevel,
    create,
  })
  await applyResolvedWorkspaceSession({
    session,
    path: options.path,
    queryClient: options.queryClient,
    refreshWorkspaceTree: options.refreshWorkspaceTree,
    navigate: options.navigate,
    create,
  })
  return { skipped: false }
}

export async function applyResolvedWorkspaceSession(options: {
  session: SessionResolveResponse
  path: string
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: string; params: { sessionId: string } }) => void
  create: boolean
}): Promise<void> {
  const state = useAgentStore.getState()
  state.beginResolvedSession(options.session.id, {
    workspace: options.session.workspace ?? options.path,
    model: options.session.model ?? state.sessionModel,
    thinkingLevel: options.session.thinking_level ?? state.sessionThinkingLevel,
    skipInitialRestore: options.create && options.session.created,
  })
  if (options.create && options.session.created) {
    prependSession(options.queryClient, options.session)
    prependWorkspaceSession(options.queryClient, options.path, options.session)
  }
  await options.refreshWorkspaceTree()
  options.navigate({ to: '/$sessionId', params: { sessionId: options.session.id } })
}

/**
 * Hide a repository from the sidebar. Its sessions stay in the backend, and
 * reopening the folder un-hides it.
 *
 * - Its worktrees are hidden with it: the workspace tree keeps listing a
 *   hidden repository while any worktree under it is still visible.
 * - Every hidden path leaves the saved workspace list before the view leaves
 *   it. The empty route reopens the last workspace, and resolving a session
 *   there would un-hide the workspace straight away.
 *
 * Everything up to the first request runs synchronously, so callers may
 * fire and forget. Returns ``expandedWorkspaces`` without the hidden paths.
 */
export async function confirmWorkspaceRemoval(options: {
  path: string
  /** Worktrees listed under the repository. */
  worktreePaths?: readonly string[]
  activeWorkspace: string | null
  expandedWorkspaces: Set<string>
  queryClient: QueryClient
  refreshWorkspaceTree: () => Promise<void>
  navigate: (args: { to: '/'; replace: true }) => void
  setCodingWorkspaceVisibilityFn?: typeof setCodingWorkspaceVisibility
}): Promise<Set<string>> {
  const paths = [options.path, ...(options.worktreePaths ?? [])]
  for (const path of paths) removeWorkspace(path)
  if (options.activeWorkspace && paths.includes(options.activeWorkspace)) {
    options.navigate({ to: '/', replace: true })
  }
  const setVisibility = options.setCodingWorkspaceVisibilityFn ?? setCodingWorkspaceVisibility
  await Promise.all(paths.map((path) => setVisibility(path, true)))
  await options.queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
  await options.refreshWorkspaceTree()
  const next = new Set(options.expandedWorkspaces)
  for (const path of paths) next.delete(path)
  return next
}
