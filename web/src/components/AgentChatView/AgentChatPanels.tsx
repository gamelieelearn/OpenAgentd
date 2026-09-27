import { CommandPalette, QuickOpen } from '../CommandPalette'
import { SchedulerPanel } from '../SchedulerPanel'
import { SessionSettingsPanel } from '../SessionSettingsPanel'
import { TodosPopover } from '../TodosPopover'
import type { TodoItem, WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'

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
  /** Command id whose page the palette opens on. */
  palettePage?: string | null
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
  palettePage,
  paletteCommands,
  quickOpenOpen,
  quickOpenWorkspaceFiles,
  quickOpenFilesTruncated,
  onQuickOpenFileOpen,
  onClosePalette,
  onCloseQuickOpen,
}: AgentChatPanelsProps) {
  return (
    <>
      <SessionSettingsPanel
        open={agentCapabilitiesOpen}
        workspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        onSessionModelSettingsChange={onSessionModelSettingsChange}
        onClose={onCloseAgentCapabilities}
      />
      <TodosPopover
        open={showTodos}
        onOpenChange={onShowTodosChange}
        todos={todos}
      />
      <SchedulerPanel
        open={schedulerOpen}
        onClose={onCloseScheduler}
      />
      {showPalette && (
        <CommandPalette commands={paletteCommands} initialPage={palettePage} onClose={onClosePalette} />
      )}
      {quickOpenOpen && (
        <QuickOpen workspaceFiles={quickOpenWorkspaceFiles} filesTruncated={quickOpenFilesTruncated} commands={paletteCommands} onFileOpen={onQuickOpenFileOpen} onClose={onCloseQuickOpen} />
      )}
    </>
  )
}
