/**
 * Tab state for the review dock's editor strip.
 *
 * Owns which tabs are open and which is active; keeps terminal tabs in step
 * with the terminal store; resets to the workspace's defaults when the dock is
 * handed another workspace; handles the shell's "open terminal" and "open
 * Tasks / Schedule" requests; and closes the active tab on Mod+W. Opening
 * tabs that need query data (changed files, commits by sha) stays with the
 * dock, which owns those queries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useShallow } from 'zustand/react/shallow'

import type { GitCommit, WorkspaceFileInfo } from '@/api/types'
import { useTerminalStore } from '@/stores/useTerminalStore'

import type { ChangedFileInfo } from './diff-helpers'
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
  terminalIdFromTabId,
  terminalTabId,
} from './dock-tabs'

/** Insert a tab before the terminal group so terminals stay at the end. */
function withTab(current: DockTab[], tab: DockTab): DockTab[] {
  const index = current.findIndex((item) => item.id === tab.id)
  if (index >= 0) return current.map((item, i) => (i === index ? tab : item))
  const firstTerminal = current.findIndex((item) => item.type === 'terminal')
  if (tab.type === 'terminal' || firstTerminal < 0) return [...current, tab]
  return [...current.slice(0, firstTerminal), tab, ...current.slice(firstTerminal)]
}

interface DockTabsOptions {
  workspace: string
  chatWorkspace: boolean
  os: string
  onFileSelect?: (file: WorkspaceFileInfo | null) => void
  terminalOpenKey: number
  handledTerminalOpenKeyRef?: React.RefObject<number | null>
  viewRequest: DockViewRequest | null
  handledViewRequestKeyRef?: React.RefObject<number>
  onActiveViewChange?: (view: DockView | null) => void
}

export function useDockTabs({
  workspace,
  chatWorkspace,
  os,
  onFileSelect,
  terminalOpenKey,
  handledTerminalOpenKeyRef: parentHandledTerminalOpenKeyRef,
  viewRequest,
  handledViewRequestKeyRef: parentHandledViewRequestKeyRef,
  onActiveViewChange,
}: DockTabsOptions) {
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

  const terminalMetas = useTerminalStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((meta) => meta.contextKey === workspace)
        .sort((a, b) => a.order - b.order),
    ),
  )

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

  const openDiffTab = useCallback((file: ChangedFileInfo) => {
    openTab({ id: diffTabId(file.path), type: 'diff', title: basename(file.path), path: file.path, status: file.status })
  }, [openTab])

  const openCommitTab = useCallback((commit: GitCommit) => {
    openTab({ id: commitTabId(commit.sha), type: 'commit', title: commit.short_sha, commit })
  }, [openTab])

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

  return {
    tabs,
    visibleTabs,
    activeTabId,
    setActiveTabId,
    activeTab,
    terminalMetas,
    openTab,
    openFileTab,
    openDiffTab,
    openCommitTab,
    openTerminal,
    closeTab,
  }
}
