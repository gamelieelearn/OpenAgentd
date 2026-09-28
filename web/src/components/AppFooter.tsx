/**
 * AppFooter — full-width desktop status bar (VS Code / Zed convention).
 *
 * Left cluster is workspace-scoped, right cluster is session-scoped:
 *   • left:  connected backend and its health · git branch with ahead/behind
 *            + dirty count
 *   • right: active model (thinking level) · fast mode · 24h spend · settings
 *
 * The command palette entry lives in the header's command center, so the
 * footer carries no help button. Hidden below ``md``; mobile surfaces these
 * in the sidebar drawer footer instead.
 */
import { memo } from 'react'
import {
  GitBranch,
  Settings,
  Sparkles,
  Zap,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { HealthDot } from './HealthDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import { useObservabilitySummaryQuery } from '@/queries/useObservabilitySummaryQuery'
import { formatSpend } from '@/utils/telemetryFormat'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceStatus } from '@/api/client'
import { cn } from '@/lib/utils'

// The summary endpoint only refreshes on demand; poll so spend follows turns.
const SPEND_REFRESH_MS = 60_000

export interface AppFooterProps {
  workspace?: string | null
  /**
   * True when ``workspace`` is the chat root (see ``useChatWorkspace``). Chat
   * workspaces are not repositories, so the branch + dirty indicator is
   * dropped and the git status probe is skipped.
   */
  chatWorkspace?: boolean
  sessionId?: string | null
  sessionModel?: string | null
  sessionThinkingLevel?: string | null
  sessionFastMode?: boolean
  onToggleSessionSettings?: () => void
  onOpenGitChanges?: () => void
  className?: string
}

/** Shared status-bar item: 20px tall, 11px text, keycap hover. */
const ITEM =
  'flex h-5 min-w-0 items-center gap-1 rounded-xs px-1.5 text-[11px] text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring)'
const ICON_ITEM =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring)'

function Divider() {
  return <div className="mx-0.5 h-3 w-px shrink-0 bg-(--color-border-subtle)" aria-hidden="true" />
}

function syncLabel(ahead: number | null | undefined, behind: number | null | undefined): string | null {
  const parts: string[] = []
  if (ahead) parts.push(`${ahead} to push`)
  if (behind) parts.push(`${behind} to pull`)
  return parts.length > 0 ? parts.join(', ') : null
}

export const AppFooter = memo(function AppFooter({
  workspace,
  chatWorkspace = false,
  sessionModel,
  sessionThinkingLevel,
  sessionFastMode,
  onToggleSessionSettings,
  onOpenGitChanges,
  className,
}: AppFooterProps) {
  const { os } = usePlatform()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const spend = useObservabilitySummaryQuery(1, {}, { refetchInterval: SPEND_REFRESH_MS }).data?.totals.estimated_cost_usd
  const spendLabel = spend === undefined ? null : formatSpend(spend)

  const isProject = Boolean(workspace) && !chatWorkspace
  const statusQuery = useQuery({
    queryKey: queryKeys.coding.status(workspace ?? ''),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace!, signal),
    enabled: isProject,
    staleTime: 10_000,
  })

  const gitStatus = statusQuery.data
  const isGit = gitStatus?.is_git_repo === true
  const branch = gitStatus?.branch
  const staged = gitStatus?.dirty?.staged ?? 0
  const unstaged = gitStatus?.dirty?.unstaged ?? 0
  const untracked = gitStatus?.dirty?.untracked ?? 0
  const dirtyTotal = staged + unstaged + untracked
  const ahead = gitStatus?.commits_ahead ?? null
  const behind = gitStatus?.commits_behind ?? null
  const sync = syncLabel(ahead, behind)

  const branchTooltip = [
    `Git branch: ${branch}`,
    dirtyTotal > 0 ? `${dirtyTotal} changed files` : null,
    sync,
  ].filter(Boolean).join(' · ')

  return (
    <footer
      className={cn(
        'hidden h-(--spacing-status-bar) shrink-0 select-none items-center justify-between gap-2 border-t border-(--color-border) bg-(--bg-page) px-2 text-[11px] text-(--color-text-muted) md:flex dark:bg-(--bg-sidebar)',
        className,
      )}
      role="status"
      aria-label="Application status"
    >
      {/* Left cluster — workspace scope: connection, repository state. */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <HealthDot labeled />

        {isProject && isGit && branch && (
          <>
            <Divider />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenGitChanges}
                    className={cn(ITEM, 'max-w-[240px] font-mono')}
                  >
                    <GitBranch size={11} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                    <span className="truncate">{branch}</span>
                    {ahead ? <span className="shrink-0" aria-label={`${ahead} commits to push`}>↑{ahead}</span> : null}
                    {behind ? <span className="shrink-0" aria-label={`${behind} commits to pull`}>↓{behind}</span> : null}
                    {dirtyTotal > 0 && (
                      <span className="shrink-0 rounded-xs bg-(--accent-orange-soft) px-1 font-semibold text-(--accent-orange-text)">*{dirtyTotal}</span>
                    )}
                  </button>
                }
              />
              <TooltipContent>{branchTooltip}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Right cluster — session scope, then app utilities. */}
      <div className="flex min-w-0 shrink items-center justify-end gap-0.5">
        {sessionModel && (
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={
                <button
                  type="button"
                  onClick={onToggleSessionSettings}
                  className={cn(ITEM, 'max-w-[320px] font-mono lg:max-w-[440px]')}
                >
                  <Sparkles size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                  <span className="truncate">{sessionModel}</span>
                  {sessionThinkingLevel && sessionThinkingLevel !== 'off' && (
                    <span className="shrink-0 text-(--color-text-subtle)">({sessionThinkingLevel})</span>
                  )}
                </button>
              }
            />
            <TooltipContent>{`Active Model: ${sessionModel}${sessionThinkingLevel ? ` (thinking: ${sessionThinkingLevel})` : ''} (${shortcutLabel(APP_SHORTCUTS.sessionSettings, os)})`}</TooltipContent>
          </Tooltip>
        )}

        {sessionFastMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded-xs bg-(--accent-orange-soft) px-1 font-mono text-[11px] font-medium text-(--accent-orange-text)">
                  <Zap size={9} aria-hidden="true" />
                  <span>fast</span>
                </span>
              }
            />
            <TooltipContent>Fast mode active</TooltipContent>
          </Tooltip>
        )}

        {(sessionModel || sessionFastMode) && <Divider />}

        {spendLabel && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => openTelemetry({ days: 1 })}
                  className={cn(ITEM, 'font-mono tabular-nums')}
                  aria-label={`Spend in the last 24 hours: ${spendLabel}`}
                >
                  <span>{spendLabel}</span>
                  <span className="text-(--color-text-subtle)">24h</span>
                </button>
              }
            />
            <TooltipContent>Spend in the last 24 hours · Open Telemetry</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => openSettings()}
                className={ICON_ITEM}
                aria-label="Settings"
              >
                <Settings size={12} aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent>{`Settings (${shortcutLabel(APP_SHORTCUTS.settings, os)})`}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  )
})
