/**
 * Review dock tab model.
 *
 * The dock is an editor-style strip: one pinned Git review tab plus any
 * number of file previews, full-height diffs, commit views, and terminals.
 * The agent task list and the scheduler are singleton tabs opened on demand
 * (⌘T and the Scheduled Tasks command on desktop).
 * Tab ids are stable per target so re-opening a file, diff, or commit
 * focuses the existing tab instead of stacking duplicates.
 */
import type { GitCommit, WorkspaceFileInfo } from '@/api/types'
import { type ChangedFileStatus, safeDecodeURIComponent } from './diff-helpers'

export const REVIEW_TAB_ID = 'review'
export const TASKS_TAB_ID = 'tasks'
export const SCHEDULE_TAB_ID = 'schedule'

export type DockTab =
  | { id: typeof REVIEW_TAB_ID; type: 'review'; title: 'Git' }
  | { id: typeof TASKS_TAB_ID; type: 'tasks'; title: 'Tasks' }
  | { id: typeof SCHEDULE_TAB_ID; type: 'schedule'; title: 'Schedule' }
  | { id: string; type: 'file'; title: string; file: WorkspaceFileInfo }
  | { id: string; type: 'diff'; title: string; path: string; status: ChangedFileStatus }
  | { id: string; type: 'commit'; title: string; commit: GitCommit }
  | { id: string; type: 'terminal'; title: string; termId: string }

export type DockTabOf<T extends DockTab['type']> = Extract<DockTab, { type: T }>

/** Singleton view tabs the shell can ask the dock to open (Tasks / Scheduled Tasks). */
export type DockView = 'tasks' | 'schedule'

/**
 * A file tab's info at render time. Tabs keep the listing entry they opened
 * with, which goes stale when the agent or a discard changes the file; prefer
 * the current entry for the same path, and mark the file deleted once the
 * working diff says so. A path merely missing from the listing is not treated
 * as deleted: the listing skips ignored files that can still be previewed.
 */
export function resolveFileTabInfo(
  snapshot: WorkspaceFileInfo,
  listed: WorkspaceFileInfo | undefined,
  workingStatus: ChangedFileStatus | undefined,
): WorkspaceFileInfo {
  if (listed) return listed
  if (workingStatus === 'D') return { ...snapshot, size: 0, deleted: true }
  return snapshot
}

export interface DockViewRequest {
  /** A singleton view, or ``review`` for the pinned Git tab. */
  view: DockView | 'review'
  /** Monotonic; the dock handles each key once. */
  key: number
}

export const REVIEW_TAB: DockTabOf<'review'> = { id: REVIEW_TAB_ID, type: 'review', title: 'Git' }
export const TASKS_TAB: DockTabOf<'tasks'> = { id: TASKS_TAB_ID, type: 'tasks', title: 'Tasks' }
export const SCHEDULE_TAB: DockTabOf<'schedule'> = { id: SCHEDULE_TAB_ID, type: 'schedule', title: 'Schedule' }

/** Tabs whose title is a plain label rather than a path or sha. */
export function isViewTab(tab: DockTab): boolean {
  return tab.type === 'review' || tab.type === 'tasks' || tab.type === 'schedule'
}

export const fileTabId = (path: string) => `file:${path}`
export const diffTabId = (path: string) => `diff:${path}`
export const commitTabId = (sha: string) => `commit:${sha}`
export const terminalTabId = (termId: string) => `terminal:${termId}`

const TERMINAL_PREFIX = 'terminal:'

/** Terminal session id encoded in a tab id, or ``null`` for other tabs. */
export function terminalIdFromTabId(tabId: string): string | null {
  return tabId.startsWith(TERMINAL_PREFIX) ? tabId.slice(TERMINAL_PREFIX.length) : null
}

export function basename(path: string): string {
  return path.split('/').pop() || path
}

/**
 * Accessible name for a tab. File and diff tabs for the same path share a
 * visible title, so the diff tab's name says what it is.
 */
export function dockTabLabel(tab: DockTab): string {
  switch (tab.type) {
    case 'diff':
      return `${tab.title} diff`
    case 'commit':
      return `Commit ${tab.commit.short_sha}`
    case 'schedule':
      return 'Scheduled tasks'
    default:
      return tab.title
  }
}

/** Hover text: the full path or subject the truncated tab title stands for. */
export function dockTabTooltip(tab: DockTab): string | null {
  switch (tab.type) {
    case 'file':
      return tab.file.path
    case 'diff':
      return `${tab.path} (working tree diff)`
    case 'commit':
      return safeDecodeURIComponent(tab.commit.subject)
    default:
      return null
  }
}
