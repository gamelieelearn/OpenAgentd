/**
 * useCommandPalette — Command Palette assembly, coding-mode palette file
 * search, view-mode cycling, and the window-level keyboard shortcut map.
 *
 * These are grouped together because most of the shortcut handlers (view
 * cycling, palette toggle, workspace files, sidebar/terminal toggles) are
 * *also* the actions the palette lists as commands — keeping them in one
 * hook avoids threading the same dozen callbacks through two separate
 * places in the shell.
 */
import { useCallback, useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useHotkeys } from '@tanstack/react-hotkeys'
import { useQuery } from '@tanstack/react-query'
import {
  WORKSPACE_FILES_STALE_MS,
  codingWorkspaceFilesQueryOptions,
} from '@/queries/workspace-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { getPlatform } from '@/hooks/use-platform'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'
import { useLayoutStore } from '@/stores/useLayoutStore'
import type { WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'
import { useAgentCommands } from './useAgentCommands'

export interface UseCommandPaletteArgs {
  workspace: string | null
  quickOpenOpen: boolean
  sessionIdState: string | null
  /** True while the review dock is mounted (``codingPanel !== null``). */
  codingPanelOpen: boolean

  handleNewSession: () => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void
  handleToggleAgentCapabilities: () => void
  /** Desktop + workspace: the dock's Tasks tab; otherwise the popover. */
  handleToggleTasks: () => void
  handleTogglePalette: () => void
  handleToggleQuickOpen: () => void
  handleToggleScheduler: () => void
  handleOpenTerminal: () => void
  handleFindInTranscript: () => void

  setCodingFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  setCodingFileOpenKey: Dispatch<SetStateAction<number>>
  setCodingPanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
}

export interface UseCommandPaletteResult {
  paletteCommands: Command[]
  quickOpenWorkspaceFiles: WorkspaceFileInfo[]
  /** The backend listing hit its file cap — surfaced in the Quick Open footer. */
  quickOpenFilesTruncated: boolean
  handleQuickOpenFileOpen: (file: WorkspaceFileInfo) => void
}

export function useCommandPalette({
  workspace,
  quickOpenOpen,
  sessionIdState,
  codingPanelOpen,
  handleNewSession,
  handleWorkspaceFiles,
  handleCodingSidebarToggle,
  handleToggleAgentCapabilities,
  handleToggleTasks,
  handleTogglePalette,
  handleToggleQuickOpen,
  handleToggleScheduler,
  handleOpenTerminal,
  handleFindInTranscript,
  setCodingFileViewer,
  setCodingFileOpenKey,
  setCodingPanel,
}: UseCommandPaletteArgs): UseCommandPaletteResult {
  const isMobile = useIsMobile()

  // ⌘⇧D — maximize the review dock over the chat (Zed's panel zoom). Opens
  // the dock first when it is closed. Mobile docks are already full-screen.
  const handleToggleDockMaximized = useCallback(() => {
    if (!workspace || isMobile) return
    const layout = useLayoutStore.getState()
    if (!codingPanelOpen) {
      setCodingPanel('changed')
      layout.setDockMaximized(true)
      return
    }
    layout.toggleDockMaximized()
  }, [codingPanelOpen, isMobile, setCodingPanel, workspace])

  const paletteCommands = useAgentCommands({
    toggleAgentCapabilities: handleToggleAgentCapabilities,
    toggleTasks: handleToggleTasks,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    handleNewSession,
    handleOpenTerminal,
    handleFindInTranscript,
    handleToggleDockMaximized: workspace && !isMobile ? handleToggleDockMaximized : undefined,
  })

  // ── Quick Open workspace file search ───────────────────────────────────────
  //
  // Fetch the active workspace file listing when Quick Open is open. We reuse
  // the same query key as the @-mention picker so the two
  // share a cache entry — no extra network request when both are warm.
  const hasQuickOpenWorkspace = Boolean(workspace)
  const quickOpenQueryOptions = codingWorkspaceFilesQueryOptions(workspace ?? '')
  const { data: paletteFilesData } = useQuery<
    { files: WorkspaceFileInfo[]; truncated?: boolean },
    Error,
    { files: WorkspaceFileInfo[]; truncated?: boolean },
    readonly unknown[]
  >({
    // Must cache the *full* response, not a narrowed { files } object — the
    // coding file tree reads the same entry. See ``workspace-files.ts``.
    ...quickOpenQueryOptions,
    enabled: quickOpenOpen && hasQuickOpenWorkspace,
    staleTime: WORKSPACE_FILES_STALE_MS,
  })

  const quickOpenWorkspaceFiles = quickOpenOpen ? (paletteFilesData?.files ?? []) : []
  const quickOpenFilesTruncated = quickOpenOpen && Boolean(paletteFilesData?.truncated)

  const handleQuickOpenFileOpen = useCallback((file: WorkspaceFileInfo) => {
    setCodingFileViewer(file)
    setCodingFileOpenKey((k) => k + 1)
    setCodingPanel((prev) => prev ?? 'files')
  }, [setCodingFileViewer, setCodingFileOpenKey, setCodingPanel])

  const { os } = getPlatform()
  useHotkeys(
    [
      { hotkey: 'Mod+N', callback: handleNewSession, options: { meta: { name: 'New session' } } },
      { hotkey: 'Mod+Shift+A', callback: handleToggleAgentCapabilities, options: { meta: { name: 'Agent capabilities' } } },
      { hotkey: 'Mod+F', callback: handleFindInTranscript, options: { meta: { name: 'Find in transcript' } } },
      { hotkey: 'Mod+D', callback: handleWorkspaceFiles, options: { meta: { name: 'Workspace files' } } },
      { hotkey: 'Mod+Shift+D', callback: handleToggleDockMaximized, options: { enabled: !isMobile && Boolean(workspace), meta: { name: 'Maximize review dock' } } },
      { hotkey: 'Mod+T', callback: handleToggleTasks, options: { enabled: Boolean(sessionIdState), meta: { name: 'Todos' } } },
      { hotkey: 'Mod+P', callback: handleToggleQuickOpen, options: { enabled: !isMobile && hasQuickOpenWorkspace, meta: { name: 'Quick Open' } } },
      { hotkey: 'Mod+K', callback: handleTogglePalette, options: { enabled: !isMobile, meta: { name: 'Command palette' } } },
      // Mod+B belongs to the general sidebar. Only the coding sidebar owns this
      // registration when coding mode is active, preventing duplicate handlers.
      { hotkey: 'Mod+B', callback: handleCodingSidebarToggle, options: { meta: { name: 'Coding sidebar' } } },
      { hotkey: 'Mod+S', callback: handleToggleScheduler, options: { meta: { name: 'Scheduler' } } },
      {
        hotkey: 'Mod+I',
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
