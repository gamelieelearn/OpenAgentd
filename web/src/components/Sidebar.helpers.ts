import type {
  CodingWorkspaceTreeRepository,
  CodingWorkspaceTreeWorktree,
  SessionResponse,
} from '@/api/types'

export function toggleExpandedPath(current: Set<string>, path: string): Set<string> {
  const next = new Set(current)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export function addExpandedPaths(
  current: Set<string>,
  paths: Array<string | null | undefined>,
): Set<string> {
  const next = new Set(current)
  for (const path of paths) {
    if (path) next.add(path)
  }
  return next
}

export function buildWorktreeSourceByDirectory(
  workspaceTree: CodingWorkspaceTreeRepository[],
): Map<string, string> {
  const worktreeSourceByDirectory = new Map<string, string>()
  for (const repo of workspaceTree) {
    for (const item of repo.worktrees) {
      worktreeSourceByDirectory.set(item.path, repo.path)
    }
  }
  return worktreeSourceByDirectory
}

export function sourceWorkspacePaths(
  workspaceTree: CodingWorkspaceTreeRepository[],
  removedWorktreePaths: Set<string>,
): string[] {
  return workspaceTree
    .map((repo) => repo.path)
    .filter((path) => !removedWorktreePaths.has(path))
}

export function groupSessionsByWorkspace(
  sessions: SessionResponse[],
): Map<string, SessionResponse[]> {
  const byWorkspace = new Map<string, SessionResponse[]>()
  for (const session of sessions) {
    if (!session.workspace) continue
    const existing = byWorkspace.get(session.workspace)
    if (existing) existing.push(session)
    else byWorkspace.set(session.workspace, [session])
  }
  return byWorkspace
}

export function visibleNestedWorktrees(
  repository: CodingWorkspaceTreeRepository | undefined,
  removedWorktreePaths: Set<string>,
): CodingWorkspaceTreeWorktree[] {
  return (repository?.worktrees ?? []).filter(
    (item) => !removedWorktreePaths.has(item.path),
  )
}

/**
 * The checkouts a repository row lists: all of them (its own path, then each
 * visible worktree), or the one ``selectedPath`` names. A selection that no
 * longer exists falls back to all.
 */
export function repositoryCheckouts(
  path: string,
  repository: CodingWorkspaceTreeRepository | undefined,
  removedWorktreePaths: Set<string>,
  selectedPath: string | undefined,
): {
  worktrees: CodingWorkspaceTreeWorktree[]
  /** The one checkout shown, or ``null`` for all of them. */
  selected: string | null
  selectedWorktree: CodingWorkspaceTreeWorktree | null
  listPaths: string[]
  worktreeNames: Map<string, string>
} {
  const worktrees = visibleNestedWorktrees(repository, removedWorktreePaths)
  const selectedWorktree = worktrees.find((item) => item.path === selectedPath) ?? null
  const selected = selectedPath === path || selectedWorktree ? (selectedPath ?? null) : null
  return {
    worktrees,
    selected,
    selectedWorktree,
    listPaths: selected ? [selected] : [path, ...worktrees.map((item) => item.path)],
    worktreeNames: new Map(worktrees.map((item) => [item.path, item.name])),
  }
}
