/**
 * useOverlayState — mobile/desktop panel & drawer state for AgentChatView.
 *
 * Owns every "big surface" toggle in the chat layout: the session
 * sidebar, the coding workspace panel + detached file viewer, the
 * workspace files panel, todos popover, mobile chat-actions
 * menu, and the mobile edge-swipe drawer controller that ties sidebar /
 * actions / coding-panel together as a single-open-at-a-time group.
 *
 * ── Mobile single-overlay rule ──────────────────────────────────────────
 *
 * On mobile every large surface — the session sidebar, chat-actions menu,
 * coding workspace panel, session settings (agent capabilities), the
 * scheduler, todos, the files panel and the command palette
 * — is a full-screen or near-full-screen overlay. Having two open at once
 * is always a layering bug, so opening any one closes all the others.
 *
 * ``useUIStore`` already enforces this *among* scheduler / capabilities /
 * palette, and ``useEdgeSwipe`` enforces it among the drawers — but the
 * two islands plus todos / files panel never coordinated across each
 * other. ``closeOtherMobileOverlays`` is the cross-island bridge.
 *
 * Mobile-only: sidebar / chat-actions / coding-panel are full-screen
 * overlays that shouldn't stack — guarded behind ``isMobile``.
 * Todos / files / capabilities / scheduler / palette are shared surfaces
 * that must not stack on *either* platform, so those run unconditionally.
 *
 * ── Desktop dock views ──────────────────────────────────────────────────
 *
 * On desktop with a workspace, the agent task list and the scheduler open
 * as review-dock tabs instead of the popover / overlay. The request mirrors
 * the terminal pattern: a keyed request plus a parent-owned "handled" ref, so
 * a dock that mounts in response still honours it, and a later ⌘D does not
 * replay it. The dock reports its active view back so a second press of the
 * same shortcut hides the dock (VS Code's panel toggle).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { listCodingWorkspaceFiles } from '@/api/client'
import { queryKeys } from '@/queries'
import { useUIStore } from '@/stores/useUIStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { resolveSidebarCollapsed, SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT } from '@/lib/workbench-layout'
import { useViewportAtLeast } from '@/hooks/use-viewport-width'
import { useEdgeSwipe, type EdgeSwipeHandlers } from '@/hooks/use-edge-swipe'
import type { WorkspaceFileInfo } from '@/api/types'
import type { DockView, DockViewRequest } from '../CodingWorkspacePanel/dock-tabs'
import { overlaysToClose, type MobileOverlay } from './mobileOverlays'

export type { DockView, DockViewRequest }

export interface UseOverlayStateArgs {
  isMobile: boolean
  workspace: string | null
  toggleScheduler: () => void
  toggleAgentCapabilities: () => void
  togglePalette: () => void
  toggleQuickOpen: () => void
}

export interface UseOverlayStateResult {
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>
  codingPanel: null | 'changed' | 'files'
  setCodingPanel: Dispatch<SetStateAction<null | 'changed' | 'files'>>
  codingFileViewer: WorkspaceFileInfo | null
  setCodingFileViewer: Dispatch<SetStateAction<WorkspaceFileInfo | null>>
  codingFileOpenKey: number
  setCodingFileOpenKey: Dispatch<SetStateAction<number>>
  terminalOpenKey: number
  handledTerminalOpenKeyRef: React.RefObject<number>
  dockViewRequest: DockViewRequest | null
  handledDockViewKeyRef: React.RefObject<number>
  /** Dock view tab currently focused in the mounted dock, else ``null``. */
  dockActiveView: DockView | null
  setDockActiveView: Dispatch<SetStateAction<DockView | null>>
  /** True when tasks / scheduler open as dock tabs (desktop + workspace). */
  dockViewsEnabled: boolean
  codingSidebarCollapsed: boolean
  setCodingSidebarCollapsed: Dispatch<SetStateAction<boolean>>
  openWorkspaceDialogKey: number
  showTodos: boolean
  showMobileActions: boolean

  closeOtherMobileOverlays: (keep: MobileOverlay) => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void
  handleOpenWorkspaceDialog: () => void
  handleCodingFileSelect: (file: WorkspaceFileInfo | null) => void
  handleMentionFileOpen: (path: string) => Promise<void>
  closeMobileActionsMenu: () => void
  handleSetShowMobileActions: Dispatch<SetStateAction<boolean>>
  handleToggleAgentCapabilities: () => void
  handleToggleScheduler: () => void
  handleTogglePalette: () => void
  handleToggleQuickOpen: () => void
  handleSetShowTodos: Dispatch<SetStateAction<boolean>>
  /** ⌘T, the header Tasks button, and the palette's Task List command. */
  handleToggleTasks: () => void
  handleToggleFilesPanel: () => void
  handleOpenTerminal: () => void
  closeAllDrawers: () => void
  openLeftDrawer: () => void
  openRightDrawer: () => void

  edgeSwipeHandlers: EdgeSwipeHandlers
  sidebarDragOffset: number | null
  actionsDragOffset: number | null
  codingPanelDragOffset: number | null
}

export function useOverlayState({
  isMobile,
  workspace,
  toggleScheduler,
  toggleAgentCapabilities,
  togglePalette,
  toggleQuickOpen,
}: UseOverlayStateArgs): UseOverlayStateResult {
  const queryClient = useQueryClient()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [codingPanel, setCodingPanel] = useState<null | 'changed' | 'files'>(null)
  const [codingFileViewer, setCodingFileViewer] = useState<WorkspaceFileInfo | null>(null)
  const [codingFileOpenKey, setCodingFileOpenKey] = useState(0)
  // Terminal is available in coding workspaces.
  const [terminalOpenKey, setTerminalOpenKey] = useState(0)
  const handledTerminalOpenKeyRef = useRef(0)
  const [dockViewRequest, setDockViewRequest] = useState<DockViewRequest | null>(null)
  const handledDockViewKeyRef = useRef(0)
  const [dockActiveView, setDockActiveView] = useState<DockView | null>(null)
  const dockViewsEnabled = !isMobile && Boolean(workspace)
  // Desktop sidebar collapse is persisted in the layout store. Until the user
  // toggles it once, wide windows open with the sidebar expanded.
  const storedSidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed)
  const wideViewport = useViewportAtLeast(SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT)
  const codingSidebarCollapsed = resolveSidebarCollapsed(storedSidebarCollapsed, wideViewport)
  const setCodingSidebarCollapsed = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    useLayoutStore.getState().setSidebarCollapsed(
      value,
      resolveSidebarCollapsed(useLayoutStore.getState().sidebarCollapsed, wideViewport),
    )
  }, [wideViewport])
  const [openWorkspaceDialogKey, setOpenWorkspaceDialogKey] = useState(0)
  const [showTodos, setShowTodos] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)

  useEffect(() => {
    setCodingFileViewer(null)
  }, [workspace])

  // Maximize is a per-opening affordance: closing the dock always restores
  // the chat so the next ⌘D opens side by side.
  useEffect(() => {
    if (codingPanel === null) useLayoutStore.getState().setDockMaximized(false)
  }, [codingPanel])

  useEffect(() => {
    if (isMobile) {
      useUIStore.getState().closeAgentCapabilities()
    }
  }, [isMobile])

  const closeOtherMobileOverlays = useCallback((keep: MobileOverlay) => {
    const toClose = new Set(overlaysToClose(keep))
    if (isMobile && (toClose.has('sidebar') || toClose.has('actions') || toClose.has('coding-panel'))) {
      setMobileSidebarOpen(false)
      setShowMobileActions(false)
      setCodingPanel(null)
      setCodingFileViewer(null)
    }
    if (toClose.has('todos')) setShowTodos(false)
    const ui = useUIStore.getState()
    if (toClose.has('scheduler')) ui.closeScheduler()
    if (toClose.has('capabilities')) ui.closeAgentCapabilities()
    if (toClose.has('palette')) {
      ui.closePalette()
      ui.closeQuickOpen()
    }
  }, [isMobile])

  const handleWorkspaceFiles = useCallback(() => {
    if (workspace) {
        if (isMobile) { setMobileSidebarOpen(false); closeOtherMobileOverlays('coding-panel') }
        setCodingPanel((value) => (value === null ? 'changed' : null))
      } else {
        setCodingSidebarCollapsed(false)
        setOpenWorkspaceDialogKey((value) => value + 1)
      }
  }, [closeOtherMobileOverlays, isMobile, setCodingSidebarCollapsed, workspace])

  const handleCodingSidebarToggle = useCallback(() => {
    if (isMobile) {
      setCodingPanel(null)
      setCodingFileViewer(null)
      setMobileSidebarOpen((value) => {
        const next = !value
        if (next) closeOtherMobileOverlays('sidebar')
        return next
      })
      return
    }
    setCodingSidebarCollapsed((value) => !value)
  }, [closeOtherMobileOverlays, isMobile, setCodingSidebarCollapsed])

  const handleOpenWorkspaceDialog = useCallback(() => {
    setCodingSidebarCollapsed(false)
    setOpenWorkspaceDialogKey((value) => value + 1)
  }, [setCodingSidebarCollapsed])

  const handleCodingFileSelect = useCallback((file: WorkspaceFileInfo | null) => {
    setCodingFileViewer(file)
  }, [])

  const handleMentionFileOpen = useCallback(async (path: string) => {
    if (!workspace) return
    const cleanPath = path.split('#', 1)[0]
    if (!cleanPath) return
    const current = codingFileViewer?.path === cleanPath ? codingFileViewer : null
    if (current) {
      setCodingFileViewer(current)
      setCodingFileOpenKey((value) => value + 1)
      setCodingPanel((value) => value ?? 'files')
      return
    }
    try {
      const result = await queryClient.fetchQuery({
        queryKey: queryKeys.coding.files(workspace),
        queryFn: () => listCodingWorkspaceFiles(workspace),
        staleTime: 5_000,
      })
      const file = result.files.find((item) => item.path === cleanPath)
      if (file) {
        setCodingFileViewer(file)
        setCodingFileOpenKey((value) => value + 1)
        setCodingPanel((value) => value ?? 'files')
      }
    } catch {
      // Keep the current panel state; the panel query will surface listing errors.
    }
  }, [codingFileViewer, queryClient, workspace])

  const closeMobileActionsMenu = useCallback(() => setShowMobileActions(false), [])

  const handleSetShowMobileActions = useCallback<typeof setShowMobileActions>((value) => {
    setShowMobileActions((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) {
        closeOtherMobileOverlays('actions')
        setMobileSidebarOpen(false)
      }
      return next
    })
  }, [closeOtherMobileOverlays])

  // Cross-platform overlay toggles: when opening one overlay, close the rest.
  // closeOtherMobileOverlays now coordinates todos/files/capabilities on both
  // desktop and mobile; sidebar/actions guards stay mobile-only.
  const handleToggleAgentCapabilities = useCallback(() => {
    if (!useUIStore.getState().agentCapabilitiesOpen) closeOtherMobileOverlays('capabilities')
    toggleAgentCapabilities()
  }, [closeOtherMobileOverlays, toggleAgentCapabilities])

  // Second press of the same view's shortcut hides the dock; otherwise the
  // dock opens (if needed) and focuses that view's tab.
  const toggleDockView = useCallback((view: DockView) => {
    if (codingPanel !== null && dockActiveView === view) {
      setCodingPanel(null)
      return
    }
    closeOtherMobileOverlays('coding-panel')
    setCodingPanel((value) => value ?? 'changed')
    setDockViewRequest((prev) => ({ view, key: (prev?.key ?? 0) + 1 }))
  }, [closeOtherMobileOverlays, codingPanel, dockActiveView])

  const handleToggleScheduler = useCallback(() => {
    if (dockViewsEnabled) {
      toggleDockView('schedule')
      return
    }
    if (!useUIStore.getState().schedulerOpen) closeOtherMobileOverlays('scheduler')
    toggleScheduler()
  }, [closeOtherMobileOverlays, dockViewsEnabled, toggleDockView, toggleScheduler])

  const handleTogglePalette = useCallback(() => {
    if (!useUIStore.getState().paletteOpen) closeOtherMobileOverlays('palette')
    togglePalette()
  }, [closeOtherMobileOverlays, togglePalette])

  const handleToggleQuickOpen = useCallback(() => {
    if (!useUIStore.getState().quickOpenOpen) closeOtherMobileOverlays('palette')
    toggleQuickOpen()
  }, [closeOtherMobileOverlays, toggleQuickOpen])

  const handleSetShowTodos = useCallback<typeof setShowTodos>((value) => {
    setShowTodos((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) closeOtherMobileOverlays('todos')
      return next
    })
  }, [closeOtherMobileOverlays])

  const handleToggleTasks = useCallback(() => {
    if (dockViewsEnabled) toggleDockView('tasks')
    else handleSetShowTodos((value) => !value)
  }, [dockViewsEnabled, handleSetShowTodos, toggleDockView])

  // The fallback popover must not linger when the dock takes over (e.g. a
  // workspace attaches while it is open on desktop).
  useEffect(() => {
    if (dockViewsEnabled) setShowTodos(false)
  }, [dockViewsEnabled])

  const handleToggleFilesPanel = handleWorkspaceFiles

  // Open (or focus) a terminal — coding mode only for now. Ensures the
  // workspace panel is visible, then bumps the key so CodingWorkspacePanel
  // focuses/opens its terminal tab (cwd = project).
  // terminal UI (kept simple; may return later behind its own entry point).
  const handleOpenTerminal = useCallback(() => {
    if (!workspace) return
    setCodingPanel((prev) => prev ?? 'files')
    setTerminalOpenKey((k) => k + 1)
  }, [workspace])

  // ── Mobile edge-swipe drawers ──────────────────────────────────────────────
  //
  // One controller owns every mobile drawer so only ONE can be open at a
  // time. The previous implementation tracked each drawer's open state in
  // isolation, which let a left-edge swipe open the sidebar while the
  // right-side actions/coding panel was already open (and vice-versa).
  //
  // Right-edge target depends on context: in a coding workspace it opens
  // the workspace panel (changed files / tree); otherwise the chat-actions
  // menu. Left-edge always opens the session sidebar.
  const codingPanelOpenForSwipe = Boolean(workspace)

  // Single source of truth for "what is open right now". Closing routes to
  // whichever drawer the id names, so swipe-to-close hits the right one.
  const activeDrawer: string | null = mobileSidebarOpen
    ? 'sidebar'
    : showMobileActions
      ? 'actions'
      : codingPanel !== null
        ? 'coding-panel'
        : null

  const closeAllDrawers = useCallback(() => {
    setMobileSidebarOpen(false)
    setShowMobileActions(false)
    setCodingPanel(null)
    setCodingFileViewer(null)
  }, [])

  const openLeftDrawer = useCallback(() => {
    // Opening the sidebar must vacate every other overlay first.
    closeOtherMobileOverlays('sidebar')
    setShowMobileActions(false)
    setCodingPanel(null)
    setCodingFileViewer(null)
    setMobileSidebarOpen(true)
  }, [closeOtherMobileOverlays])

  const openRightDrawer = useCallback(() => {
    // Opening a right drawer must vacate the sidebar + other overlays first.
    setMobileSidebarOpen(false)
    if (codingPanelOpenForSwipe) {
      closeOtherMobileOverlays('coding-panel')
      setShowMobileActions(false)
      setCodingPanel((value) => value ?? 'changed')
    } else {
      closeOtherMobileOverlays('actions')
      setShowMobileActions(true)
    }
  }, [closeOtherMobileOverlays, codingPanelOpenForSwipe])

  const { handlers: edgeSwipeHandlers, drag: edgeSwipeDrag } = useEdgeSwipe({
    activeDrawer,
    left: { id: 'sidebar', open: openLeftDrawer },
    right: { id: codingPanelOpenForSwipe ? 'coding-panel' : 'actions', open: openRightDrawer },
    close: closeAllDrawers,
  })

  // Live drag offset (px) per drawer, fed to each drawer so it tracks the
  // finger. Each drawer reads only its own id; null when not being dragged.
  const sidebarDragOffset = edgeSwipeDrag?.drawerId === 'sidebar' ? edgeSwipeDrag.offset : null
  const actionsDragOffset = edgeSwipeDrag?.drawerId === 'actions' ? edgeSwipeDrag.offset : null
  const codingPanelDragOffset = edgeSwipeDrag?.drawerId === 'coding-panel' ? edgeSwipeDrag.offset : null

  return {
    mobileSidebarOpen,
    setMobileSidebarOpen,
    codingPanel,
    setCodingPanel,
    codingFileViewer,
    setCodingFileViewer,
    codingFileOpenKey,
    setCodingFileOpenKey,
    terminalOpenKey,
    handledTerminalOpenKeyRef,
    dockViewRequest,
    handledDockViewKeyRef,
    dockActiveView,
    setDockActiveView,
    dockViewsEnabled,
    codingSidebarCollapsed,
    setCodingSidebarCollapsed,
    openWorkspaceDialogKey,
    showTodos,
    showMobileActions,

    closeOtherMobileOverlays,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    handleOpenWorkspaceDialog,
    handleCodingFileSelect,
    handleMentionFileOpen,
    closeMobileActionsMenu,
    handleSetShowMobileActions,
    handleToggleAgentCapabilities,
    handleToggleScheduler,
    handleTogglePalette,
    handleToggleQuickOpen,
    handleSetShowTodos,
    handleToggleTasks,
    handleToggleFilesPanel,
    handleOpenTerminal,
    closeAllDrawers,
    openLeftDrawer,
    openRightDrawer,

    edgeSwipeHandlers,
    sidebarDragOffset,
    actionsDragOffset,
    codingPanelDragOffset,
  }
}
