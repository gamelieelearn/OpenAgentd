import { GitBranch } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getCodingWorkspaceStatus } from '@/api/client'
import { queryKeys } from '@/queries/keys'

function syncLabel(ahead: number | null | undefined, behind: number | null | undefined): string | null {
  const parts: string[] = []
  if (ahead) parts.push(`${ahead} to push`)
  if (behind) parts.push(`${behind} to pull`)
  return parts.length > 0 ? parts.join(', ') : null
}

/** `▸ branch ↑n ↓n *dirty` after the header workspace name; nothing outside a Git repo. */
export function HeaderBranch({ workspace, onClick }: { workspace: string; onClick: () => void }) {
  const { data: status } = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    staleTime: 10_000,
  })
  const branch = status?.is_git_repo ? status.branch : null
  if (!branch) return null

  const dirtyTotal = (status?.dirty?.staged ?? 0) + (status?.dirty?.unstaged ?? 0) + (status?.dirty?.untracked ?? 0)
  const ahead = status?.commits_ahead ?? null
  const behind = status?.commits_behind ?? null
  const tooltip = [
    `Git branch: ${branch}`,
    dirtyTotal > 0 ? `${dirtyTotal} changed files` : null,
    syncLabel(ahead, behind),
  ].filter(Boolean).join(' · ')

  return (
    <>
      <span className="shrink-0 text-(--color-text-subtle)" aria-hidden="true">▸</span>
      <Tooltip className="min-w-0 shrink">
        <TooltipTrigger
          className="min-w-0"
          render={
            <button
              type="button"
              onClick={onClick}
              className="flex h-6 min-w-0 max-w-48 items-center gap-1 rounded-xs px-1 font-mono text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            >
              <GitBranch size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
              <span className="truncate">{branch}</span>
              {ahead ? <span className="shrink-0" aria-label={`${ahead} commits to push`}>↑{ahead}</span> : null}
              {behind ? <span className="shrink-0" aria-label={`${behind} commits to pull`}>↓{behind}</span> : null}
              {dirtyTotal > 0 && (
                <span className="shrink-0 rounded-xs bg-(--accent-orange-soft) px-1 text-[11px] font-semibold text-(--accent-orange-text)">*{dirtyTotal}</span>
              )}
            </button>
          }
        />
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </>
  )
}
