import { Suspense, lazy, useState } from 'react'
import { CommandPalette, QuickOpen } from '../CommandPalette'
import { TodosPopover } from '../TodosPopover'
import type { TodoItem, WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'

// Both modals are closed until asked for, so they stay off the startup bundle.
const SchedulerPanel = lazy(() => import('../SchedulerPanel').then((m) => ({ default: m.SchedulerPanel })))
const SessionSettingsPanel = lazy(() =>
  import('../SessionSettingsPanel').then((m) => ({ default: m.SessionSettingsPanel })),
)

/** True from the first time ``open`` is set, so a panel mounted then can still animate out. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return opened
}

interface AgentChatPanelsProps {
  agentCapabilitiesOpen: boolean
  agentWorkspace: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  onSessionModelSettingsChange: (model: string | null, thinkingLevel: string | null) => void
  onCloseAgentCapabilities: () => void
  /** Popover fallback: mobile, or desktop without a review dock. */
  showTodos: boolean
  onShowTodosChange: (open: boolean) => void
  todos: TodoItem[]
  schedulerOpen: boolean
  onCloseScheduler: () => void
  showPalette: boolean
  paletteCommands: Command[]
  quickOpenOpen: boolean
  quickOpenWorkspaceFiles: WorkspaceFileInfo[]
  /** Backend hit its file cap — Quick Open says so instead of silently hiding. */
  quickOpenFilesTruncated?: boolean
  onQuickOpenFileOpen: (file: WorkspaceFileInfo) => void
  onClosePalette: () => void
  onCloseQuickOpen: () => void
}

export function AgentChatPanels({
  agentCapabilitiesOpen,
  agentWorkspace,
  sessionModel,
  sessionThinkingLevel,
  onSessionModelSettingsChange,
  onCloseAgentCapabilities,
  showTodos,
  onShowTodosChange,
  todos,
  schedulerOpen,
  onCloseScheduler,
  showPalette,
  paletteCommands,
  quickOpenOpen,
  quickOpenWorkspaceFiles,
  quickOpenFilesTruncated,
  onQuickOpenFileOpen,
  onClosePalette,
  onCloseQuickOpen,
}: AgentChatPanelsProps) {
  const settingsOpened = useOpenedOnce(agentCapabilitiesOpen)
  const schedulerOpened = useOpenedOnce(schedulerOpen)
  return (
    <>
      {settingsOpened && (
        <Suspense fallback={null}>
          <SessionSettingsPanel
            open={agentCapabilitiesOpen}
            workspace={agentWorkspace}
            sessionModel={sessionModel}
            sessionThinkingLevel={sessionThinkingLevel}
            onSessionModelSettingsChange={onSessionModelSettingsChange}
            onClose={onCloseAgentCapabilities}
          />
        </Suspense>
      )}
      <TodosPopover
        open={showTodos}
        onOpenChange={onShowTodosChange}
        todos={todos}
      />
      {schedulerOpened && (
        <Suspense fallback={null}>
          <SchedulerPanel
            open={schedulerOpen}
            onClose={onCloseScheduler}
          />
        </Suspense>
      )}
      {showPalette && (
        <CommandPalette commands={paletteCommands} onClose={onClosePalette} />
      )}
      {quickOpenOpen && (
        <QuickOpen workspaceFiles={quickOpenWorkspaceFiles} filesTruncated={quickOpenFilesTruncated} commands={paletteCommands} onFileOpen={onQuickOpenFileOpen} onClose={onCloseQuickOpen} />
      )}
    </>
  )
}
