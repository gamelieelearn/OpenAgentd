/**
 * Shared query options for the coding workspace's git diff endpoints.
 *
 * The review dock reads the same diffs from several places — the Changes
 * list, full-height diff tabs, the inline commit expansion, and commit tabs.
 * Sharing one factory per endpoint keeps them on one cache entry (and on the
 * keys ``cache-invalidation-bridge.ts`` refreshes after agent writes) instead
 * of each view fetching its own copy.
 *
 * ``staleTime`` / ``enabled`` stay per-observer, as in ``workspace-files.ts``.
 */
import { getCodingWorkspaceCommitDiff, getCodingWorkspaceGitDiff } from '@/api/client'
import type { WorkspaceCommitDiffResponse, WorkspaceGitDiffResponse } from '@/api/types'
import { queryKeys } from './keys'

export const WORKSPACE_DIFF_STALE_MS = 5_000
/** Commit patches are immutable, so re-expanding one should not refetch. */
export const COMMIT_DIFF_STALE_MS = 30_000

/** ``GET /agent/workspace/git-diff/view`` — whole working-tree diff. */
export function workspaceDiffQueryOptions(workspace: string) {
  return {
    queryKey: queryKeys.coding.diff(workspace),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkspaceGitDiffResponse> =>
      getCodingWorkspaceGitDiff(workspace, undefined, signal),
  }
}

/** ``GET /agent/workspace/git/commit-diff`` — one commit's patch. */
export function commitDiffQueryOptions(workspace: string, sha: string) {
  return {
    queryKey: queryKeys.coding.commitDiff(workspace, sha),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkspaceCommitDiffResponse> =>
      getCodingWorkspaceCommitDiff(workspace, sha, signal),
  }
}
