/**
 * useCommandPalette — Command Palette assembly, workspace file search,
 * view-mode cycling, and the window-level keyboard shortcut map.
 *
 * These are grouped together because most of the shortcut handlers (view
 * cycling, palette toggle, workspace files, sidebar/terminal toggles) are
 * *also* the actions the palette lists as commands — keeping them in one
 * hook avoids threading the same dozen callbacks through two separate
 * places in the shell.
 */
import { useCallback, useEffect, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useHotkeys } from '@tanstack/react-hotkeys'
import { useQuery } from '@tanstack/react-query'
import {
  WORKSPACE_FILES_STALE_MS,
  workspaceFileListQueryOptions,
} from '@/queries/workspace-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { getPlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, hotkeyOf } from '@/lib/app-shortcuts'
import { routeFindShortcut } from '@/lib/find-shortcut'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import type { WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'
import { useAgentCommands } from './useAgentCommands'
import { usePaletteSwitchCommands } from './usePaletteSwitchCommands'

export interface UseCommandPaletteArgs {
  workspace: string | null
  quickOpenOpen: boolean
  sessionIdState: string | null
  /** True while the review dock is mounted (``workspacePanel !== null``). */
  workspacePanelOpen: boolean

  handleNewSession: () => void
  handleWorkspaceFiles: () => void
  handleSidebarToggle: () => void
  handleToggleAgentCapabilities: () => void
  /** Desktop + workspace: the dock's Tasks tab; otherwise the popover. */
  handleToggleTasks: () => void
  handleTogglePalette: () => void
  handleToggleQuickOpen: () => void
  handleToggleScheduler: () => void
  handleOpenTerminal: () => void
  handleFindInTranscript: () => void
  /** Only while the session has a plan; lists Open Plan. */
  handleOpenPlan?: () => void
  planAwaitingReview?: boolean

  setFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  setFileOpenKey: Dispatch<SetStateAction<number>>
  setWorkspacePanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
}

export interface UseCommandPaletteResult {
  paletteCommands: Command[]
  quickOpenWorkspaceFiles: WorkspaceFileInfo[]
  /** The backend listing hit its file cap — surfaced in the Quick Open footer. */
  quickOpenFilesTruncated: boolean
  /** Opens the pick in the dock, at the lines the query named. */
  handleQuickOpenFileOpen: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
}

export function useCommandPalette({
  workspace,
  quickOpenOpen,
  sessionIdState,
  workspacePanelOpen,
  handleNewSession,
  handleWorkspaceFiles,
  handleSidebarToggle,
  handleToggleAgentCapabilities,
  handleToggleTasks,
  handleTogglePalette,
  handleToggleQuickOpen,
  handleToggleScheduler,
  handleOpenTerminal,
  handleFindInTranscript,
  handleOpenPlan,
  planAwaitingReview,
  setFileViewer,
  setFileOpenKey,
  setWorkspacePanel,
}: UseCommandPaletteArgs): UseCommandPaletteResult {
  const isMobile = useIsMobile()

  // ⌘⇧D — maximize the review dock over the chat (Zed's panel zoom). Opens
  // the dock first when it is closed. Mobile docks are already full-screen.
  const handleToggleDockMaximized = useCallback(() => {
    if (!workspace || isMobile) return
    const layout = useLayoutStore.getState()
    if (!workspacePanelOpen) {
      setWorkspacePanel('changed')
      layout.setDockMaximized(true)
      return
    }
    layout.toggleDockMaximized()
  }, [workspacePanelOpen, isMobile, setWorkspacePanel, workspace])

  const agentCommands = useAgentCommands({
    toggleAgentCapabilities: handleToggleAgentCapabilities,
    toggleTasks: handleToggleTasks,
    toggleScheduler: handleToggleScheduler,
    handleWorkspaceFiles,
    handleSidebarToggle,
    handleNewSession,
    handleOpenTerminal,
    handleFindInTranscript,
    handleToggleDockMaximized: workspace && !isMobile ? handleToggleDockMaximized : undefined,
    handleOpenPlan,
    planAwaitingReview,
  })
  const switchCommands = usePaletteSwitchCommands({ workspace, sessionId: sessionIdState })
  const paletteCommands = useMemo(() => [...agentCommands, ...switchCommands], [agentCommands, switchCommands])

  // ── Quick Open workspace file search ───────────────────────────────────────
  //
  // Fetch the active workspace file listing when Quick Open is open. We reuse
  // the same query key as the @-mention picker so the two
  // share a cache entry — no extra network request when both are warm.
  const hasQuickOpenWorkspace = Boolean(workspace)
  const quickOpenQueryOptions = workspaceFileListQueryOptions(workspace ?? '')
  const { data: paletteFilesData } = useQuery<
    { files: WorkspaceFileInfo[]; truncated?: boolean },
    Error,
    { files: WorkspaceFileInfo[]; truncated?: boolean },
    readonly unknown[]
  >({
    // Must cache the *full* response, not a narrowed { files } object — the
    // workspace file tree reads the same entry. See ``workspace-files.ts``.
    ...quickOpenQueryOptions,
    enabled: quickOpenOpen && hasQuickOpenWorkspace,
    staleTime: WORKSPACE_FILES_STALE_MS,
  })

  const quickOpenWorkspaceFiles = quickOpenOpen ? (paletteFilesData?.files ?? []) : []
  const quickOpenFilesTruncated = quickOpenOpen && Boolean(paletteFilesData?.truncated)

  const handleQuickOpenFileOpen = useCallback((file: WorkspaceFileInfo, line?: number, endLine?: number) => {
    setFileViewer(file)
    setFileOpenKey((k) => k + 1)
    setWorkspacePanel((prev) => prev ?? 'files')
    if (line) useFileRevealStore.getState().reveal(file.path, line, endLine)
  }, [setFileViewer, setFileOpenKey, setWorkspacePanel])

  const { os } = getPlatform()
  useHotkeys(
    [
      { hotkey: hotkeyOf(APP_SHORTCUTS.newSession), callback: handleNewSession, options: { meta: { name: 'New session' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.sessionSettings), callback: handleToggleAgentCapabilities, options: { meta: { name: 'Agent capabilities' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.findInTranscript), callback: () => routeFindShortcut(handleFindInTranscript), options: { meta: { name: 'Find in transcript or sessions' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.workspaceFiles), callback: handleWorkspaceFiles, options: { meta: { name: 'Workspace files' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.maximizeDock), callback: handleToggleDockMaximized, options: { enabled: !isMobile && Boolean(workspace), meta: { name: 'Maximize review dock' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.tasks), callback: handleToggleTasks, options: { enabled: Boolean(sessionIdState), meta: { name: 'Todos' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.quickOpen), callback: handleToggleQuickOpen, options: { enabled: !isMobile && hasQuickOpenWorkspace, meta: { name: 'Quick Open' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.commandPalette), callback: handleTogglePalette, options: { enabled: !isMobile, meta: { name: 'Command palette' } } },
      { hotkey: hotkeyOf(APP_SHORTCUTS.sidebar), callback: handleSidebarToggle, options: { meta: { name: 'Sidebar' } } },
      {
        hotkey: hotkeyOf(APP_SHORTCUTS.focusChat),
        callback: () => {
          // The composer is inert under a maximized dock; restore it first.
          useLayoutStore.getState().setDockMaximized(false)
          window.dispatchEvent(new CustomEvent('focus-chat-input'))
        },
        options: { meta: { name: 'Focus chat input' } },
      },
    ],
    {
      target: document,
      platform: os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux',
      preventDefault: true,
      stopPropagation: false,
      ignoreInputs: false,
    },
  )

  // Keep this physical-key shortcut custom: layouts can report Shift+Backquote
  // as `~`, `` ` ``, or `Dead`, which a character hotkey cannot represent.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.code !== 'Backquote' || !isPrimaryShortcut(event, os, { shift: true })) return
      event.preventDefault()
      handleOpenTerminal()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleOpenTerminal, os])

  return {
    paletteCommands,
    quickOpenWorkspaceFiles,
    quickOpenFilesTruncated,
    handleQuickOpenFileOpen,
  }
}
