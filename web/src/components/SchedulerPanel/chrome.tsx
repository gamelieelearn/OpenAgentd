/**
 * Scheduler surface chrome.
 *
 * The scheduler renders in two hosts: the full-screen / centered overlay
 * (mobile, and desktop without a workspace) and the desktop review dock's
 * Schedule tab. Pane headers sit on the overlay's rail tone, but on the page
 * tone in the dock so the active editor tab opens onto its content.
 */
import { createContext, useContext } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type SchedulerChrome = 'overlay' | 'dock'

export const SchedulerChromeContext = createContext<SchedulerChrome>('overlay')

export function useSchedulerChrome(): SchedulerChrome {
  return useContext(SchedulerChromeContext)
}

/** Class for a detail / form pane header in the current host. */
export function useSchedulerPaneHeaderClass(): string {
  return useSchedulerChrome() === 'dock'
    ? 'border-b border-(--color-border-subtle) bg-(--bg-page) px-3 py-2'
    : 'border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-2.5 @xl:px-5'
}

/** Leading back control for stacked (list → detail) hosts. */
export function SchedulerBackButton({ onClick, label = 'Back to task list' }: { onClick: () => void; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
            aria-label={label}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
