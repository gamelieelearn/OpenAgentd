/**
 * DockTabBar — the review dock's editor-tab strip.
 *
 * One row: scrolling tabs on the left, a fixed action cluster on the right
 * (new terminal, refresh, and on desktop maximize; file search is Quick
 * Open, ⌘P). Hiding the
 * dock lives on the header's review-dock toggle (and ⌘D), which is always
 * visible because the dock never covers the header.
 * Tabs stay plain buttons with ``aria-current`` rather than an ARIA
 * ``tablist``: terminal tabs carry their own context menu / long-press sheet
 * and file tabs a sibling close button, which roving-tabindex tab semantics
 * do not model well.
 */
import { CalendarClock, FileDiff, GitCommitHorizontal, GitCompare, ListTodo, Maximize2, Minimize2, RefreshCw, TerminalSquare, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileTypeIcon } from '../FileTypeIcon'
import { TerminalTabButton } from '../Terminal/TerminalTabButton'
import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { cn } from '@/lib/utils'
import type { TerminalSessionMeta } from '@/stores/useTerminalStore'
import {
  DOCK_ACTION_BUTTON_CLASS,
  dockTabButtonClass,
  dockTabClass,
  dockTabCloseClass,
} from './dock-tab-styles'
import { type DockTab, dockTabLabel, dockTabTooltip, isViewTab } from './dock-tabs'


export interface DockTabBarProps {
  tabs: DockTab[]
  activeTabId: string
  workspace: string
  terminalMetas: TerminalSessionMeta[]
  mobile: boolean
  os: OS
  registerTabRef: (id: string, node: HTMLButtonElement | null) => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNewTerminal: () => void
  onRefresh: () => void
  /** ``null`` hides the toggle (mobile, or a forced narrow-window overlay). */
  maximized: boolean | null
  onToggleMaximized: () => void
}

function TabIcon({ tab }: { tab: DockTab }) {
  switch (tab.type) {
    case 'review':
      return <GitCompare size={12} className="shrink-0" aria-hidden="true" />
    case 'tasks':
      return <ListTodo size={12} className="shrink-0" aria-hidden="true" />
    case 'schedule':
      return <CalendarClock size={12} className="shrink-0" aria-hidden="true" />
    case 'file':
      return <FileTypeIcon name={tab.file.name || tab.file.path} size={13} />
    case 'diff':
      return <FileDiff size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
    case 'commit':
      return <GitCommitHorizontal size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
    default:
      return null
  }
}

function ActionButton({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" onClick={onClick} className={DOCK_ACTION_BUTTON_CLASS} aria-label={label}>
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function DockTabBar({
  tabs,
  activeTabId,
  workspace,
  terminalMetas,
  mobile,
  os,
  registerTabRef,
  onActivate,
  onClose,
  onNewTerminal,
  onRefresh,
  maximized,
  onToggleMaximized,
}: DockTabBarProps) {
  return (
    <div className="flex h-(--spacing-tab-bar) min-w-0 shrink-0 bg-(--bg-sidebar)">
      <div className="scrollbar-none flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        {tabs.map((tab) => {
          const active = activeTabId === tab.id
          if (tab.type === 'terminal') {
            return (
              <TerminalTabButton
                key={tab.id}
                buttonRef={(node) => registerTabRef(tab.id, node)}
                meta={terminalMetas.find((m) => m.id === tab.termId) ?? {
                  id: tab.termId, contextKey: workspace, title: tab.title, status: 'connecting', order: 0,
                }}
                active={active}
                mobile={mobile}
                onActivate={() => onActivate(tab.id)}
              />
            )
          }
          const closable = tab.type !== 'review'
          const label = dockTabLabel(tab)
          const tooltip = dockTabTooltip(tab)
          const tabButton = (
            <button
              ref={(node) => registerTabRef(tab.id, node)}
              type="button"
              aria-current={active ? 'true' : undefined}
              aria-label={label === tab.title ? undefined : label}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(event) => {
                if (!closable || event.button !== 1) return
                event.preventDefault()
                onClose(tab.id)
              }}
              className={cn(dockTabButtonClass(closable), 'flex-1')}
            >
              <TabIcon tab={tab} />
              <span className={cn('truncate', !isViewTab(tab) && 'font-mono')}>{tab.title}</span>
            </button>
          )
          return (
            <div key={tab.id} className={dockTabClass(active)}>
              {tooltip ? (
                <Tooltip className="h-full min-w-0 flex-1">
                  <TooltipTrigger className="h-full min-w-0 flex-1" render={tabButton} />
                  <TooltipContent side="bottom">{tooltip}</TooltipContent>
                </Tooltip>
              ) : tabButton}
              {closable && (
                <button
                  type="button"
                  onClick={() => onClose(tab.id)}
                  className={dockTabCloseClass(active)}
                  aria-label={`Close ${label}`}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
        <div aria-hidden="true" className="min-w-2 flex-1 border-b border-(--color-border)" />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-(--color-border) px-1">
        <ActionButton label="New terminal" onClick={onNewTerminal}>
          <TerminalSquare size={14} aria-hidden="true" />
        </ActionButton>
        <ActionButton label="Refresh" onClick={onRefresh}>
          <RefreshCw size={14} aria-hidden="true" />
        </ActionButton>
        {!mobile && maximized !== null && (
          <ActionButton
            label={`${maximized ? 'Restore' : 'Maximize'} review dock (${shortcutLabel(APP_SHORTCUTS.maximizeDock, os)})`}
            onClick={onToggleMaximized}
          >
            {maximized
              ? <Minimize2 size={13} aria-hidden="true" />
              : <Maximize2 size={13} aria-hidden="true" />}
          </ActionButton>
        )}
      </div>
    </div>
  )
}
