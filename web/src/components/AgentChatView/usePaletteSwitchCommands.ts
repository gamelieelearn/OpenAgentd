/**
 * Wires ``buildSwitchCommands`` to live data and to the code paths the
 * sidebar's session and workspace switch already use. The session and
 * workspace-tree queries
 * share their keys with the sidebar, so this adds no requests on desktop.
 */
import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { getCodingWorkspaceTree } from '@/api/client'
import { queryKeys } from '@/queries'
import { useSessionsQuery } from '@/queries/useSessionsQuery'
import { useToastStore } from '@/stores/useToastStore'
import { applySessionSelection } from '../CodingSidebar.sessions'
import { selectCodingWorkspace } from '../CodingSidebar.workspace'
import type { Command } from '../CommandPalette'
import { buildSwitchCommands } from './paletteSwitchCommands'

const WORKSPACE_TREE_STALE_MS = 30_000

export function usePaletteSwitchCommands({
  workspace,
  sessionId,
}: {
  workspace: string | null
  sessionId: string | null
}): Command[] {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: sessionPages } = useSessionsQuery()
  const { data: tree = null } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })

  return useMemo(() => buildSwitchCommands(
    {
      currentSessionId: sessionId,
      currentWorkspace: workspace,
      sessions: sessionPages?.pages.flatMap((page) => page.data) ?? [],
      tree,
    },
    {
      openSession: (session) => applySessionSelection({ session, workspacePath: session.workspace ?? '', navigate }),
      openWorkspace: (path) => {
        selectCodingWorkspace({
          path,
          requestedCreate: false,
          currentSessionId: sessionId ?? undefined,
          currentWorkspace: workspace,
          queryClient,
          refreshWorkspaceTree: () => queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() }),
          navigate,
        }).catch((err: unknown) => {
          useToastStore.getState().push({
            tone: 'error',
            title: 'Could not open workspace',
            description: err instanceof Error ? err.message : undefined,
          })
        })
      },
    },
  ), [navigate, queryClient, sessionId, sessionPages, tree, workspace])
}
