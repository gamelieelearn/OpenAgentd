/**
 * DockActionMenus — the review dock's per-row action surfaces.
 *
 * Desktop: right-click menus anchored at the pointer. Mobile: long-press
 * action sheets with the same choices. Both route into the panel's
 * handlers; this module only renders. The discard confirmation lives here
 * too because both surfaces open it.
 */
import { Copy, ExternalLink, FileDiff, FolderOpen, RotateCcw, Undo2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { softHapticFeedback } from '@/lib/haptics'
import type { ChangedFileInfo } from './diff-helpers'

export interface CommitActionTarget {
  sha: string
  shortSha: string
  subject: string
}

type At<T> = T & { x: number; y: number }

export interface DockActionMenusProps {
  mobileFileActions: ChangedFileInfo | null
  setMobileFileActions: (value: ChangedFileInfo | null) => void
  desktopFileActions: { file: ChangedFileInfo; x: number; y: number } | null
  setDesktopFileActions: (value: { file: ChangedFileInfo; x: number; y: number } | null) => void
  mobileCommitActions: CommitActionTarget | null
  setMobileCommitActions: (value: CommitActionTarget | null) => void
  desktopCommitActions: At<CommitActionTarget> | null
  setDesktopCommitActions: (value: At<CommitActionTarget> | null) => void
  isLatestCommit: boolean
  gitActionPending: boolean
  /** Whether ``path`` has working-tree changes (a diff tab would be empty otherwise). */
  hasWorkingDiff: (path: string) => boolean
  onOpenFile: (path: string) => void
  onOpenDiffTab: (file: ChangedFileInfo) => void
  onOpenCommitTab: (sha: string) => void
  onUndoCommit: () => void
  onRevertCommit: (sha: string, shortSha: string) => void
  discardTarget: ChangedFileInfo | null
  setDiscardTarget: (value: ChangedFileInfo | null) => void
  discarding: boolean
  onConfirmDiscard: () => void
}

const MENU_CLASS = 'fixed z-50 min-w-40 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs shadow-md'
const MENU_ITEM_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-left text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:bg-(--bg-key) focus-visible:outline-none disabled:opacity-50'
const MENU_ITEM_DANGER_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none disabled:opacity-50'
const MENU_DIVIDER = <div role="separator" className="my-1 border-t border-(--color-border-subtle)" />

function copy(text: string) {
  void navigator.clipboard?.writeText(text)
}

/** Keep a pointer-anchored menu inside the viewport. */
function menuPosition(x: number, y: number, height: number) {
  if (typeof window === 'undefined') return { top: y, left: x }
  return {
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    left: Math.max(8, Math.min(x, window.innerWidth - 176)),
  }
}

function ContextMenu({ onDismiss, style, label, children }: {
  onDismiss: () => void
  style: { top: number; left: number }
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 bg-transparent"
      onClick={onDismiss}
      onContextMenu={(e) => { e.preventDefault(); onDismiss() }}
    >
      <div role="menu" aria-label={label} className={MENU_CLASS} style={style} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

export function DockActionMenus({
  mobileFileActions,
  setMobileFileActions,
  desktopFileActions,
  setDesktopFileActions,
  mobileCommitActions,
  setMobileCommitActions,
  desktopCommitActions,
  setDesktopCommitActions,
  isLatestCommit,
  gitActionPending,
  hasWorkingDiff,
  onOpenFile,
  onOpenDiffTab,
  onOpenCommitTab,
  onUndoCommit,
  onRevertCommit,
  discardTarget,
  setDiscardTarget,
  discarding,
  onConfirmDiscard,
}: DockActionMenusProps) {
  return (
    <>
      <Dialog open={mobileFileActions !== null} onOpenChange={(open) => { if (!open) setMobileFileActions(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{mobileFileActions?.path ?? ''}</DialogTitle>
            <DialogDescription>Choose an action for this file.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            {mobileFileActions && hasWorkingDiff(mobileFileActions.path) && (
              <Button type="button" variant="ghost" className="justify-start" onClick={() => {
                const f = mobileFileActions; setMobileFileActions(null)
                softHapticFeedback()
                onOpenDiffTab(f)
              }}>
                <FileDiff size={14} aria-hidden="true" />
                Open diff in tab
              </Button>
            )}
            {mobileFileActions?.status !== 'D' && (
              <Button type="button" variant="ghost" className="justify-start" onClick={() => {
                const f = mobileFileActions; setMobileFileActions(null)
                if (!f) return
                softHapticFeedback()
                onOpenFile(f.path)
              }}>
                <FolderOpen size={14} aria-hidden="true" />
                Open file
              </Button>
            )}
            <Button type="button" variant="ghost" className="justify-start" onClick={() => {
              const f = mobileFileActions; setMobileFileActions(null)
              if (!f) return
              softHapticFeedback()
              copy(f.path)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy file path
            </Button>
            <Button type="button" variant="danger-subtle" className="justify-start" onClick={() => {
              const f = mobileFileActions
              setMobileFileActions(null)
              if (f) setDiscardTarget(f)
            }}>
              <Undo2 size={14} aria-hidden="true" />
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mobileCommitActions !== null} onOpenChange={(open) => { if (!open && !gitActionPending) setMobileCommitActions(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{mobileCommitActions?.subject ?? ''}</DialogTitle>
            <DialogDescription>SHA: {mobileCommitActions?.shortSha}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              onOpenCommitTab(c.sha)
            }}>
              <ExternalLink size={14} aria-hidden="true" />
              Open in tab
            </Button>
            {isLatestCommit && (
              <Button
                type="button"
                variant="danger-subtle"
                className="justify-start"
                disabled={gitActionPending}
                onClick={() => { if (mobileCommitActions) onUndoCommit() }}
              >
                <Undo2 size={14} aria-hidden="true" />
                {gitActionPending ? 'Undoing…' : 'Undo commit'}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              disabled={gitActionPending}
              onClick={() => {
                const c = mobileCommitActions
                if (c) onRevertCommit(c.sha, c.shortSha)
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {gitActionPending ? 'Reverting…' : 'Revert commit'}
            </Button>
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              copy(c.shortSha)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy short SHA
            </Button>
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              copy(c.sha)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy full SHA
            </Button>
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              copy(c.subject)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy commit message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {desktopCommitActions && (
        <ContextMenu
          label={`Actions for commit ${desktopCommitActions.shortSha}`}
          onDismiss={() => setDesktopCommitActions(null)}
          style={menuPosition(desktopCommitActions.x, desktopCommitActions.y, 190)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const c = desktopCommitActions; setDesktopCommitActions(null)
              onOpenCommitTab(c.sha)
            }}
            className={MENU_ITEM_CLASS}
          >
            <ExternalLink size={12} aria-hidden="true" />
            Open in tab
          </button>
          {MENU_DIVIDER}
          {isLatestCommit && (
            <button
              type="button"
              role="menuitem"
              disabled={gitActionPending}
              onClick={onUndoCommit}
              className={MENU_ITEM_DANGER_CLASS}
            >
              <Undo2 size={12} aria-hidden="true" />
              {gitActionPending ? 'Undoing…' : 'Undo commit'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={gitActionPending}
            onClick={() => onRevertCommit(desktopCommitActions.sha, desktopCommitActions.shortSha)}
            className={MENU_ITEM_CLASS}
          >
            <RotateCcw size={12} aria-hidden="true" />
            {gitActionPending ? 'Reverting…' : 'Revert commit'}
          </button>
          {MENU_DIVIDER}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); copy(c.shortSha) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy short SHA
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); copy(c.sha) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy full SHA
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); copy(c.subject) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy commit message
          </button>
        </ContextMenu>
      )}

      {desktopFileActions && (
        <ContextMenu
          label={`Actions for ${desktopFileActions.file.path}`}
          onDismiss={() => setDesktopFileActions(null)}
          style={menuPosition(desktopFileActions.x, desktopFileActions.y, 150)}
        >
          {hasWorkingDiff(desktopFileActions.file.path) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); onOpenDiffTab(f) }}
              className={MENU_ITEM_CLASS}
            >
              <FileDiff size={12} aria-hidden="true" />
              Open diff in tab
            </button>
          )}
          {desktopFileActions.file.status !== 'D' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); onOpenFile(f.path) }}
              className={MENU_ITEM_CLASS}
            >
              <FolderOpen size={12} aria-hidden="true" />
              Open file
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); copy(f.path) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy file path
          </button>
          {MENU_DIVIDER}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); setDiscardTarget(f) }}
            className={MENU_ITEM_DANGER_CLASS}
          >
            <Undo2 size={12} aria-hidden="true" />
            Discard changes
          </button>
        </ContextMenu>
      )}

      <Dialog open={discardTarget !== null} onOpenChange={(open) => { if (!open && !discarding) setDiscardTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              Are you sure you want to discard all changes in <span className="font-mono text-(--color-text)">{discardTarget?.path}</span>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" disabled={discarding} onClick={() => setDiscardTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={discarding} onClick={onConfirmDiscard}>
              {discarding ? 'Discarding…' : 'Discard changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
