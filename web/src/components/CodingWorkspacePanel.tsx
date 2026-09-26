/**
 * CodingWorkspacePanel — the review dock.
 *
 * Editor-style tab strip (Git review, file previews, full-height diffs,
 * commits, terminals, and on desktop the agent Tasks and Schedule views)
 * over one content area. Desktop geometry comes from
 * the shell: a ratio of the center region in ``side`` mode, or the whole
 * center in ``overlay`` mode (maximized, or a window too narrow for a
 * side-by-side split). Mobile keeps the fixed full-screen sheet.
 */
import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useHotkey } from '@tanstack/react-hotkeys'
import { motion } from 'framer-motion'
import {
  getCodingWorkspaceStatus,
  getCodingWorkspaceGitHistory,
  discardCodingWorkspaceFile,
  undoCodingWorkspaceLastCommit,
  revertCodingWorkspaceCommit,
} from '@/api/client'
import { softHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'
import {
  WORKSPACE_TREE_STALE_MS,
  codingWorkspaceFilesQueryOptions,
} from '@/queries/workspace-files'
import {
  COMMIT_DIFF_STALE_MS,
  WORKSPACE_DIFF_STALE_MS,
  codingCommitDiffQueryOptions,
  codingWorkspaceDiffQueryOptions,
} from '@/queries/workspace-git'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { panelResizeHandleClass, usePanelResize } from '@/hooks/use-panel-resize'
import { useClaimStrandedFocus } from '@/hooks/use-dock-focus'
import { useElementWidth } from '@/hooks/use-element-width'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import {
  DOCK_MIN_WIDTH,
  dockMaxWidth,
  ratioFromWidth,
  resolveDockLayout,
} from '@/lib/workbench-layout'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useShallow } from 'zustand/react/shallow'
import { useToastStore } from '@/stores/useToastStore'
import type { GitCommit, TodoItem, WorkspaceFileInfo } from '@/api/types'
import { EASINGS } from '@/lib/motion'
import {
  type ChangedFileStatus,
  type ChangedFileInfo,
  type DiffFileSection,
  collectChangedFiles,
  collectDiffSections,
} from './CodingWorkspacePanel/diff-helpers'
import type { ParsedGraphLine } from './CodingWorkspacePanel/CommitDetail'
import { GitReviewSubPanel } from './CodingWorkspacePanel/GitReviewSubPanel'
import { CommitHistorySubPanel } from './CodingWorkspacePanel/CommitHistorySubPanel'
import { TerminalSubPanel } from './CodingWorkspacePanel/TerminalSubPanel'
import { FilePreviewSubPanel } from './CodingWorkspacePanel/FilePreviewSubPanel'
import { DiffTabView } from './CodingWorkspacePanel/DiffTabView'
import { CommitTabView } from './CodingWorkspacePanel/CommitTabView'
import { DockTabBar } from './CodingWorkspacePanel/DockTabBar'
import { DockActionMenus, type CommitActionTarget } from './CodingWorkspacePanel/DockActionMenus'
import {
  type GitSubTab,
  GitViewToolbar,
  gitViewPanelId,
  gitViewTabId,
} from './CodingWorkspacePanel/GitViewToolbar'
import {
  type DockTab,
  type DockView,
  type DockViewRequest,
  REVIEW_TAB,
  REVIEW_TAB_ID,
  SCHEDULE_TAB,
  TASKS_TAB,
  basename,
  commitTabId,
  diffTabId,
  fileTabId,
  resolveFileTabInfo,
  terminalIdFromTabId,
  terminalTabId,
} from './CodingWorkspacePanel/dock-tabs'

export type { ChangedFileStatus, ChangedFileInfo, DiffFileSection }

// On-demand views (⌘T / ⌘S) load with their first open rather than with
// every dock mount.
const TasksTabView = lazy(() =>
  import('./CodingWorkspacePanel/TasksTabView').then((m) => ({ default: m.TasksTabView })),
)
const SchedulerDockView = lazy(() =>
  import('./SchedulerPanel/SchedulerDockView').then((m) => ({ default: m.SchedulerDockView })),
)

const EMPTY_TODOS: TodoItem[] = []
/** Stable empty ref: with no center element the width falls back to the viewport. */
const NO_CENTER: React.RefObject<HTMLElement | null> = { current: null }

/** Insert a tab before the terminal group so terminals stay at the end. */
function withTab(current: DockTab[], tab: DockTab): DockTab[] {
  const index = current.findIndex((item) => item.id === tab.id)
  if (index >= 0) return current.map((item, i) => (i === index ? tab : item))
  const firstTerminal = current.findIndex((item) => item.type === 'terminal')
  if (tab.type === 'terminal' || firstTerminal < 0) return [...current, tab]
  return [...current.slice(0, firstTerminal), tab, ...current.slice(firstTerminal)]
}

function parseGraph(graph: string): ParsedGraphLine[] {
  if (!graph) return []
  return graph.split('\n').filter((line) => line.trim().length > 0).map((line, lineIndex) => {
    const match = /^(.*?)\b([0-9a-fA-F]{7,10})\b(.*?)$/.exec(line)
    if (!match) return { key: `line-${lineIndex}`, raw: line, graphPart: line }
    const [, graphPart, sha, restRaw] = match
    const rest = restRaw.trim()
    const decoMatch = /^\((.*?)\)\s*(.*)$/.exec(rest)
    return decoMatch
      ? { key: `line-${lineIndex}-${sha}`, raw: line, graphPart, sha, decorations: decoMatch[1], message: decoMatch[2] }
      : { key: `line-${lineIndex}-${sha}`, raw: line, graphPart, sha, message: rest }
  })
}

export function CodingWorkspacePanel({
  workspace,
  open,
  mobile = false,
  mobileDragOffset = null,
  centerRef = NO_CENTER,
  centerWidth,
  selectedFilePath = null,
  selectedFileOpenKey = 0,
  terminalOpenKey = 0,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
  viewRequest = null,
  handledViewRequestKeyRef: parentHandledViewRequestKeyRef,
  onActiveViewChange,
  todos = EMPTY_TODOS,
  sessionId = null,
  onFileSelect,
  onAddComment,
  onOpenPalette,
  chatWorkspace = false,
}: {
  workspace: string
  open: boolean
  mobile?: boolean
  mobileDragOffset?: number | null
  /**
   * The chat + dock region. The dock measures it itself, so the shell does
   * not re-render on every width change. Without it, the viewport is used.
   */
  centerRef?: React.RefObject<HTMLElement | null>
  /** Explicit center width; overrides the measurement (tests, fixed hosts). */
  centerWidth?: number
  selectedFilePath?: string | null
  selectedFileOpenKey?: number
  terminalOpenKey?: number
  handledTerminalOpenKeyRef?: React.RefObject<number | null>
  /** Shell request to open (or focus) the Tasks / Schedule tab. */
  viewRequest?: DockViewRequest | null
  /** Parent-owned so a remounted dock does not replay a handled request. */
  handledViewRequestKeyRef?: React.RefObject<number>
  /** Reports the focused view tab (``null`` for other tabs or on unmount). */
  onActiveViewChange?: (view: DockView | null) => void
  /** Agent task list for the Tasks tab. */
  todos?: TodoItem[]
  sessionId?: string | null
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  onOpenPalette?: () => void
  /**
   * True when ``workspace`` is the chat root (see ``useChatWorkspace``).
   * Chat workspaces are not repositories: the Git review tab is hidden and its
   * git queries stay disabled so opening the dock on ``~`` neither probes a
   * home-sized repo nor offers whole-home discard/revert actions.
   */
  chatWorkspace?: boolean
}) {
  const prefersReducedMotion = useReducedMotion()
  const { os } = usePlatform()
  const gitViewIdBase = useId()
  // Chat workspaces have no Git review tab — the root is not a repository.
  const defaultTabId = chatWorkspace ? '' : REVIEW_TAB_ID
  const [tabs, setTabs] = useState<DockTab[]>(chatWorkspace ? [] : [REVIEW_TAB])
  // A panel mounted for a coding workspace can be re-used for a chat one, so
  // filter the review tab out of the strip rather than only skipping it at
  // construction time.
  const visibleTabs = chatWorkspace ? tabs.filter((tab) => tab.type !== 'review') : tabs
  const [activeTabId, setActiveTabId] = useState(defaultTabId)
  // The dock stays open across workspace switches, so this instance can be
  // handed another workspace. Tabs belong to the workspace they were opened
  // in: start over with the new one's defaults (the Git tab when leaving
  // Chat, and no file tabs pointing into the old tree). Terminal tabs are
  // re-derived from the new workspace's sessions by the sync effect below.
  const [tabsWorkspace, setTabsWorkspace] = useState(workspace)
  if (tabsWorkspace !== workspace) {
    setTabsWorkspace(workspace)
    setTabs(chatWorkspace ? [] : [REVIEW_TAB])
    setActiveTabId(defaultTabId)
  }
  const [mobileFileActions, setMobileFileActions] = useState<ChangedFileInfo | null>(null)
  const [mobileCommitActions, setMobileCommitActions] = useState<CommitActionTarget | null>(null)
  const [desktopCommitActions, setDesktopCommitActions] = useState<(CommitActionTarget & { x: number; y: number }) | null>(null)
  const [desktopFileActions, setDesktopFileActions] = useState<{ file: ChangedFileInfo; x: number; y: number } | null>(null)
  const [discardTarget, setDiscardTarget] = useState<ChangedFileInfo | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [gitActionPending, setGitActionPending] = useState(false)
  const pushToast = useToastStore((s) => s.push)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const commitsScrollRef = useRef<HTMLDivElement>(null)
  const pendingScrollShaRef = useRef<string | null>(null)
  const handledFileOpenKeyRef = useRef(-1)

  // ── Geometry ───────────────────────────────────────────────────────────────
  const dockRatio = useLayoutStore((s) => s.dockRatio)
  const dockMaximized = useLayoutStore((s) => s.dockMaximized)
  const measuredCenter = useElementWidth(centerRef)
  const center = centerWidth ?? measuredCenter
  const layout = resolveDockLayout({ centerWidth: center, ratio: dockRatio, maximized: dockMaximized })
  const overlay = !mobile && layout.mode === 'overlay'
  const resize = usePanelResize({
    width: layout.width,
    min: DOCK_MIN_WIDTH,
    max: dockMaxWidth(center),
    edge: 'left',
    onCommit: (width) => useLayoutStore.getState().setDockRatio(ratioFromWidth(width, center)),
    onReset: () => useLayoutStore.getState().resetDockRatio(),
    disabled: mobile || overlay,
    label: 'Resize review dock',
  })
  const dockWidth = overlay ? layout.width : resize.width
  // The toggle is meaningless while a narrow window already forces overlay.
  const maximizeState = mobile || (overlay && !dockMaximized) ? null : dockMaximized
  // Covering the chat makes it inert, which drops its focus onto <body>.
  useClaimStrandedFocus(overlay, activeTabId, () => tabButtonRefs.current.get(activeTabId) ?? null)

  // ── Server state ──────────────────────────────────────────────────────────
  const files = useQuery({
    ...codingWorkspaceFilesQueryOptions(workspace),
    enabled: open,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  const diff = useQuery({
    ...codingWorkspaceDiffQueryOptions(workspace),
    enabled: open && !chatWorkspace,
    staleTime: WORKSPACE_DIFF_STALE_MS,
  })
  const workspaceStatus = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    enabled: open && !chatWorkspace,
    staleTime: 10_000,
  })
  const changedFiles = useMemo(() => collectChangedFiles(diff.data), [diff.data])
  const diffSections = useMemo(() => collectDiffSections(diff.data), [diff.data])
  // Working-tree status per changed path; ``has`` doubles as "is changed".
  const changedPaths = useMemo(() => new Map(changedFiles.map((file) => [file.path, file.status])), [changedFiles])
  const filesByPath = useMemo(() => new Map((files.data?.files ?? []).map((file) => [file.path, file])), [files.data?.files])

  const gitState = useGitPanelStore((s) => s.workspaces[workspace] || DEFAULT_WORKSPACE_STATE)
  const subTab = gitState.subTab
  const allBranches = gitState.allBranches
  const expandedCommitSha = gitState.expandedCommitSha
  const expandedDiffs = useMemo(() => new Set(gitState.expandedDiffs), [gitState.expandedDiffs])
  const expandedCommitFiles = useMemo(() => new Set(gitState.expandedCommitFiles), [gitState.expandedCommitFiles])

  const setSubTab = (tab: GitSubTab) => useGitPanelStore.getState().setSubTab(workspace, tab)
  const setAllBranches = (val: boolean) => useGitPanelStore.getState().setAllBranches(workspace, val)
  const setExpandedCommitSha = (updater: string | null | ((prev: string | null) => string | null)) => {
    const next = typeof updater === 'function' ? updater(gitState.expandedCommitSha) : updater
    useGitPanelStore.getState().setExpandedCommitSha(workspace, next)
  }
  const setExpandedCommitFiles = (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof updater === 'function' ? updater(new Set(gitState.expandedCommitFiles)) : updater
    useGitPanelStore.getState().setExpandedCommitFiles(workspace, Array.from(next))
  }
  const historyLimit = 50
  // "All branches" is a Tree-only toggle; the Commits list always follows HEAD.
  const historyAllBranches = subTab === 'tree' && allBranches

  const gitHistory = useInfiniteQuery({
    queryKey: queryKeys.coding.history(workspace, historyLimit, historyAllBranches),
    queryFn: ({ pageParam, signal }) => getCodingWorkspaceGitHistory(workspace, historyLimit, pageParam, historyAllBranches, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? null,
    enabled: open && !chatWorkspace && activeTabId === REVIEW_TAB_ID && (subTab === 'commits' || subTab === 'tree'),
    staleTime: 10_000,
  })

  const commits = useMemo(() => gitHistory.data?.pages.flatMap((page) => page.commits) ?? [], [gitHistory.data?.pages])

  const isLatestCommit = useMemo(() => {
    const activeSha = mobileCommitActions?.sha ?? desktopCommitActions?.sha
    if (!activeSha || commits.length === 0) return false
    return activeSha === commits[0].sha
  }, [mobileCommitActions, desktopCommitActions, commits])

  const graph = gitHistory.data?.pages[0]?.graph ?? ''
  const parsedGraphLines = useMemo(() => parseGraph(graph), [graph])

  const commitsAhead = workspaceStatus.data?.commits_ahead ?? null
  const commitsBehind = workspaceStatus.data?.commits_behind ?? null
  const upstream = workspaceStatus.data?.upstream ?? null

  const commitDiff = useQuery({
    ...codingCommitDiffQueryOptions(workspace, expandedCommitSha ?? ''),
    enabled: open && !chatWorkspace && activeTabId === REVIEW_TAB_ID && subTab === 'commits' && expandedCommitSha !== null,
    staleTime: COMMIT_DIFF_STALE_MS,
  })
  const commitDiffText = commitDiff.data?.diff
  const commitChangedFiles = useMemo(() => {
    if (!commitDiffText) return []
    return collectChangedFiles({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])
  const commitDiffSections = useMemo(() => {
    if (!commitDiffText) return new Map<string, DiffFileSection>()
    return collectDiffSections({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])

  const terminalMetas = useTerminalStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((meta) => meta.contextKey === workspace)
        .sort((a, b) => a.order - b.order),
    ),
  )

  // ── Tabs ───────────────────────────────────────────────────────────────────
  const activeTab = useMemo<DockTab | undefined>(() => {
    const found = tabs.find((item) => item.id === activeTabId)
    if (found) return found
    const termId = terminalIdFromTabId(activeTabId)
    const meta = termId ? terminalMetas.find((m) => m.id === termId) : undefined
    if (meta) return { id: activeTabId, type: 'terminal', title: meta.title, termId: meta.id }
    return tabs[0]
  }, [tabs, activeTabId, terminalMetas])

  const openTab = useCallback((tab: DockTab) => {
    setTabs((current) => withTab(current, tab))
    setActiveTabId(tab.id)
  }, [])

  const openFileTab = useCallback((file: WorkspaceFileInfo) => {
    openTab({ id: fileTabId(file.path), type: 'file', title: file.name || basename(file.path), file })
    onFileSelect?.(file)
  }, [openTab, onFileSelect])

  /** Open a changed path, synthesising file info when the listing lacks it. */
  const openChangedFile = useCallback((path: string) => {
    const file = filesByPath.get(path) ?? { path, name: basename(path), size: 0, mtime: 0, mime: 'text/plain' }
    openFileTab(file)
  }, [filesByPath, openFileTab])

  const openDiffTab = useCallback((file: ChangedFileInfo) => {
    openTab({ id: diffTabId(file.path), type: 'diff', title: basename(file.path), path: file.path, status: file.status })
  }, [openTab])

  const openCommitTab = useCallback((commit: GitCommit) => {
    openTab({ id: commitTabId(commit.sha), type: 'commit', title: commit.short_sha, commit })
  }, [openTab])

  const openCommitTabBySha = (sha: string) => {
    const commit = commits.find((item) => item.sha === sha)
    if (commit) openCommitTab(commit)
  }

  useEffect(() => {
    setTabs((current) => {
      const nonTerminal = current.filter((item) => item.type !== 'terminal')
      const terminalTabs = terminalMetas.map((meta) => {
        const existing = current.find(
          (item) => item.type === 'terminal' && item.termId === meta.id,
        )
        return existing && existing.title === meta.title
          ? existing
          : { id: terminalTabId(meta.id), type: 'terminal' as const, title: meta.title, termId: meta.id }
      })
      const changed =
        current.length !== nonTerminal.length + terminalTabs.length ||
        terminalTabs.some((tab) => !current.includes(tab))
      return changed ? [...nonTerminal, ...terminalTabs] : current
    })
  }, [terminalMetas])

  const openTerminal = useCallback(() => {
    const id = useTerminalStore.getState().open({ workspace }, workspace)
    const meta = useTerminalStore.getState().sessionsForContext(workspace).find((m) => m.id === id)
    openTab({ id: terminalTabId(id), type: 'terminal', title: meta?.title ?? `Terminal ${id}`, termId: id })
  }, [workspace, openTab])

  const focusOrOpenTerminal = useCallback(() => {
    const metas = useTerminalStore.getState().sessionsForContext(workspace)
    const last = metas[metas.length - 1]
    if (last) setActiveTabId(terminalTabId(last.id))
    else openTerminal()
  }, [workspace, openTerminal])

  const handleRefresh = useCallback(() => {
    void files.refetch()
    if (chatWorkspace) return
    void diff.refetch()
    void workspaceStatus.refetch()
    if (subTab === 'commits' || subTab === 'tree') {
      void gitHistory.refetch()
    }
  }, [files, diff, workspaceStatus, gitHistory, subTab, chatWorkspace])

  const fallbackHandledTerminalOpenKeyRef = useRef(0)
  const handledTerminalOpenKeyRef = parentHandledTerminalOpenKeyRef ?? fallbackHandledTerminalOpenKeyRef
  useEffect(() => {
    if (handledTerminalOpenKeyRef.current === null) {
      handledTerminalOpenKeyRef.current = 0
    }
    if (terminalOpenKey > handledTerminalOpenKeyRef.current) {
      handledTerminalOpenKeyRef.current = terminalOpenKey
      focusOrOpenTerminal()
    }
  }, [terminalOpenKey, focusOrOpenTerminal, handledTerminalOpenKeyRef])

  const fallbackHandledViewRequestKeyRef = useRef(0)
  const handledViewRequestKeyRef = parentHandledViewRequestKeyRef ?? fallbackHandledViewRequestKeyRef
  useEffect(() => {
    if (!viewRequest || viewRequest.key <= handledViewRequestKeyRef.current) return
    handledViewRequestKeyRef.current = viewRequest.key
    openTab(viewRequest.view === 'tasks' ? TASKS_TAB : SCHEDULE_TAB)
  }, [viewRequest, openTab, handledViewRequestKeyRef])

  const activeView: DockView | null =
    activeTab?.type === 'tasks' || activeTab?.type === 'schedule' ? activeTab.type : null
  const onActiveViewChangeRef = useRef(onActiveViewChange)
  useEffect(() => {
    onActiveViewChangeRef.current = onActiveViewChange
  }, [onActiveViewChange])
  useEffect(() => {
    onActiveViewChangeRef.current?.(activeView)
  }, [activeView])
  useEffect(() => () => onActiveViewChangeRef.current?.(null), [])

  useEffect(() => {
    // Switching an already-mounted panel to a chat workspace drops the stale
    // Git tab (the root is not a repository).
    if (chatWorkspace && activeTabId === REVIEW_TAB_ID) {
      setActiveTabId('')
      return
    }
    if (activeTabId === REVIEW_TAB_ID || activeTabId === defaultTabId) return
    const termId = terminalIdFromTabId(activeTabId)
    const known = tabs.some((tab) => tab.id === activeTabId)
    const liveTerminal = termId !== null && terminalMetas.some((m) => m.id === termId)
    if (!known && !liveTerminal) setActiveTabId(defaultTabId)
  }, [tabs, activeTabId, terminalMetas, defaultTabId, chatWorkspace])

  const closeTab = (id: string) => {
    if (id === REVIEW_TAB_ID) return
    const target = tabs.find((item) => item.id === id)
    if (target?.type === 'terminal') {
      useTerminalStore.getState().close(target.termId)
    }
    setTabs((current) => current.filter((item) => item.id !== id))
    if (activeTabId === id) {
      // Editor convention: focus the neighbour on the left, else the right.
      const index = visibleTabs.findIndex((item) => item.id === id)
      const neighbour = visibleTabs.filter((item) => item.id !== id)[Math.max(0, index - 1)]
      setActiveTabId(neighbour?.id ?? defaultTabId)
      onFileSelect?.(neighbour?.type === 'file' ? neighbour.file : null)
    }
  }

  useHotkey('Mod+W', () => closeTab(activeTabId), {
    enabled: activeTab !== undefined && activeTab.id === activeTabId && activeTab.type !== 'review',
    ignoreInputs: false,
    platform: os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux',
    preventDefault: true,
    stopPropagation: false,
    target: typeof document === 'undefined' ? null : document,
  })

  const toggleDiffExpanded = (path: string) => {
    useGitPanelStore.getState().toggleDiffExpanded(workspace, path)
  }
  const allExpanded = changedFiles.length > 0 && changedFiles.every((f) => expandedDiffs.has(f.path))
  const toggleExpandAll = () => {
    useGitPanelStore.getState().setExpandedDiffs(workspace, allExpanded ? [] : changedFiles.map((f) => f.path))
  }

  // Expansions persist per workspace; forget files that are no longer
  // changed so a later edit to them does not reopen as a stale peek and the
  // stored list does not grow forever. A truncated diff lists only part of
  // the change set, so it cannot prove a path is gone.
  useEffect(() => {
    if (!diff.data?.is_git_repo || diff.data.truncated) return
    const stored = useGitPanelStore.getState().workspaces[workspace]?.expandedDiffs ?? []
    const kept = stored.filter((path) => changedPaths.has(path))
    if (kept.length !== stored.length) useGitPanelStore.getState().setExpandedDiffs(workspace, kept)
  }, [diff.data, changedPaths, workspace])

  useEffect(() => {
    if (handledFileOpenKeyRef.current === selectedFileOpenKey) return
    if (!selectedFilePath) return
    if (files.data?.files == null) return
    const file = files.data.files.find((item) => item.path === selectedFilePath)
    if (file) {
      handledFileOpenKeyRef.current = selectedFileOpenKey
      openFileTab(file)
    }
  }, [files.data?.files, openFileTab, selectedFileOpenKey, selectedFilePath])

  useEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  useEffect(() => {
    const sha = pendingScrollShaRef.current
    if (!sha || subTab !== 'commits' || !commitsScrollRef.current) return
    const card = commitsScrollRef.current.querySelector(`[data-commit-sha="${sha}"]`)
    if (!card) return
    pendingScrollShaRef.current = null
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [subTab, commits])

  // ── Git actions ───────────────────────────────────────────────────────────
  const runCommitAction = async (
    action: () => Promise<unknown>,
    success: { title: string; description: string },
    failureTitle: string,
  ) => {
    setGitActionPending(true)
    try {
      await action()
      softHapticFeedback()
      pushToast({ tone: 'success', ...success })
      setMobileCommitActions(null)
      setDesktopCommitActions(null)
      void gitHistory.refetch()
      void diff.refetch()
      void files.refetch()
    } catch (err) {
      pushToast({ tone: 'error', title: failureTitle, description: err instanceof Error ? err.message : String(err) })
    } finally {
      setGitActionPending(false)
    }
  }

  const handleUndoCommit = () => void runCommitAction(
    () => undoCodingWorkspaceLastCommit(workspace),
    { title: 'Commit undone', description: 'The last commit was undone. Changes have been kept in your working copy.' },
    'Failed to undo commit',
  )

  const handleRevertCommit = (sha: string, shortSha: string) => void runCommitAction(
    () => revertCodingWorkspaceCommit(workspace, sha),
    { title: 'Commit reverted', description: `Successfully created revert commit for ${shortSha}.` },
    'Failed to revert commit',
  )

  const handleConfirmDiscard = async () => {
    if (!discardTarget) return
    setDiscarding(true)
    try {
      await discardCodingWorkspaceFile(workspace, discardTarget.path, discardTarget.status)
      softHapticFeedback()
      pushToast({
        tone: 'success',
        title: 'Changes discarded',
        description: `Reverted ${discardTarget.path} to its state in HEAD.`,
      })
      setDiscardTarget(null)
      void diff.refetch()
      void files.refetch()
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Failed to discard changes',
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDiscarding(false)
    }
  }

  if (!open) return null

  const reviewView = (
    <div className="flex h-full min-h-0 flex-col">
      {diff.data?.is_git_repo && (
        <GitViewToolbar
          idBase={gitViewIdBase}
          subTab={subTab}
          onSubTabChange={setSubTab}
          changedCount={changedFiles.length}
          commitsAhead={commitsAhead}
          commitsBehind={commitsBehind}
          upstream={upstream}
          mobile={mobile}
          allExpanded={changedFiles.length > 0 ? allExpanded : null}
          onToggleExpandAll={toggleExpandAll}
          allBranches={allBranches}
          onAllBranchesChange={setAllBranches}
        />
      )}
      <div
        ref={commitsScrollRef}
        id={diff.data?.is_git_repo ? gitViewPanelId(gitViewIdBase) : undefined}
        role={diff.data?.is_git_repo ? 'tabpanel' : undefined}
        aria-labelledby={diff.data?.is_git_repo ? gitViewTabId(gitViewIdBase, subTab) : undefined}
        className="min-h-0 flex-1 overflow-auto touch-pan-y"
      >
        {subTab === 'changes' ? (
          <GitReviewSubPanel
            workspace={workspace}
            changedFiles={changedFiles}
            diffSections={diffSections}
            diff={diff}
            files={files}
            selectedFilePath={selectedFilePath}
            expandedDiffs={expandedDiffs}
            toggleDiffExpanded={toggleDiffExpanded}
            openChangedFile={openChangedFile}
            openDiffTab={openDiffTab}
            mobile={mobile}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        ) : (
          <CommitHistorySubPanel
            workspace={workspace}
            subTab={subTab}
            gitHistory={gitHistory}
            commits={commits}
            expandedCommitSha={expandedCommitSha}
            setExpandedCommitSha={setExpandedCommitSha}
            expandedCommitFiles={expandedCommitFiles}
            setExpandedCommitFiles={setExpandedCommitFiles}
            commitDiff={commitDiff}
            commitChangedFiles={commitChangedFiles}
            commitDiffSections={commitDiffSections}
            parsedGraphLines={parsedGraphLines}
            commitsScrollRef={commitsScrollRef}
            pendingScrollShaRef={pendingScrollShaRef}
            setSubTab={setSubTab}
            openCommitTab={openCommitTab}
            mobile={mobile}
            setMobileCommitActions={setMobileCommitActions}
            setDesktopCommitActions={setDesktopCommitActions}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        )}
      </div>
    </div>
  )

  return (
    <motion.aside
      aria-label="Review dock"
      // Desktop always animates width (instantly under reduced motion, via
      // the transition below) so the aside is sized even when motion is off.
      initial={mobile ? { opacity: 0 } : { width: 0 }}
      animate={
        !mobile
          ? { width: dockWidth }
          : prefersReducedMotion
            ? { opacity: 1 }
            : mobileDragOffset !== null ? { opacity: 1, x: mobileDragOffset } : { opacity: 1, x: 0 }
      }
      exit={mobile ? { opacity: 0 } : { width: 0 }}
      transition={mobile && mobileDragOffset !== null
        ? { duration: 0 }
        : { duration: resize.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: EASINGS.inOut }}
      className={cn(
        'fixed bottom-0 right-0 z-40 min-h-0 w-full overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl md:w-auto md:shadow-none',
        // Overlay covers the chat column (kept mounted underneath); side mode
        // is an in-flow sibling that takes its ratio of the center.
        overlay
          ? 'md:absolute md:inset-y-0 md:right-0 md:z-20'
          : 'md:relative md:inset-y-auto md:right-auto md:z-auto md:shrink-0',
        mobile ? 'mobile-safe-top max-w-none' : 'h-full',
      )}
    >
      <div data-review-dock className="relative flex h-full min-h-0 w-full flex-col">
        {!mobile && !overlay && (
          <div {...resize.handleProps} className={panelResizeHandleClass('left', resize.isResizing)} />
        )}
        <DockTabBar
          tabs={visibleTabs}
          activeTabId={activeTabId}
          workspace={workspace}
          terminalMetas={terminalMetas}
          mobile={mobile}
          os={os}
          registerTabRef={(id, node) => {
            if (node) tabButtonRefs.current.set(id, node)
            else tabButtonRefs.current.delete(id)
          }}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onOpenPalette={onOpenPalette}
          onNewTerminal={openTerminal}
          onRefresh={handleRefresh}
          maximized={maximizeState}
          onToggleMaximized={() => useLayoutStore.getState().toggleDockMaximized()}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          {!chatWorkspace && activeTab?.type === 'review' ? (
            reviewView
          ) : activeTab?.type === 'file' ? (
            <FilePreviewSubPanel
              workspace={workspace}
              file={resolveFileTabInfo(activeTab.file, filesByPath.get(activeTab.file.path), changedPaths.get(activeTab.file.path))}
              onAddComment={onAddComment}
            />
          ) : activeTab?.type === 'diff' ? (
            <DiffTabView key={activeTab.id} workspace={workspace} path={activeTab.path} onOpenFile={openChangedFile} />
          ) : activeTab?.type === 'commit' ? (
            <CommitTabView key={activeTab.id} workspace={workspace} commit={activeTab.commit} />
          ) : activeTab?.type === 'terminal' ? (
            <TerminalSubPanel key={activeTab.termId} termId={activeTab.termId} workspace={workspace} />
          ) : activeTab?.type === 'tasks' ? (
            <Suspense fallback={null}>
              <TasksTabView todos={todos} sessionId={sessionId} />
            </Suspense>
          ) : activeTab?.type === 'schedule' ? (
            <Suspense fallback={null}>
              <SchedulerDockView contextWorkspace={chatWorkspace ? null : workspace} />
            </Suspense>
          ) : chatWorkspace ? (
            <div className="flex h-full items-center justify-center px-4">
              <p className="max-w-56 text-center text-xs text-(--color-text-subtle)">
                Open a file with{' '}
                <span className="font-medium text-(--color-text-muted)">{formatShortcut('P', os)}</span>{' '}
                or start a terminal.
              </p>
            </div>
          ) : null}
        </div>
        <DockActionMenus
          mobileFileActions={mobileFileActions}
          setMobileFileActions={setMobileFileActions}
          desktopFileActions={desktopFileActions}
          setDesktopFileActions={setDesktopFileActions}
          mobileCommitActions={mobileCommitActions}
          setMobileCommitActions={setMobileCommitActions}
          desktopCommitActions={desktopCommitActions}
          setDesktopCommitActions={setDesktopCommitActions}
          isLatestCommit={isLatestCommit}
          gitActionPending={gitActionPending}
          hasWorkingDiff={(path) => changedPaths.has(path)}
          onOpenFile={openChangedFile}
          onOpenDiffTab={openDiffTab}
          onOpenCommitTab={openCommitTabBySha}
          onUndoCommit={handleUndoCommit}
          onRevertCommit={handleRevertCommit}
          discardTarget={discardTarget}
          setDiscardTarget={setDiscardTarget}
          discarding={discarding}
          onConfirmDiscard={() => void handleConfirmDiscard()}
        />
      </div>
    </motion.aside>
  )
}
