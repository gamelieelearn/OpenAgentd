import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'

/**
 * The prompt whose answer is on screen, pinned over the transcript's top edge
 * once the prompt itself has scrolled away. An overlay, not a sticky row: an
 * in-flow row appearing above the content would shove the reading position.
 */
export function PromptHeader({ prompt, onJumpToPrompt, onPrevious, onNext }: {
  prompt: string
  onJumpToPrompt: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const { os } = usePlatform()
  const firstLine = prompt.trim().split('\n', 1)[0]
  return (
    <nav aria-label="Prompts" className="pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-1.5 sm:px-4">
      <div className="pointer-events-auto mx-auto flex max-w-3xl items-center gap-0.5 rounded-sm border border-(--color-border) bg-(--bg-card) py-0.5 pr-0.5 pl-1 shadow-xs">
        <button
          type="button"
          onClick={onJumpToPrompt}
          aria-label={`Jump to prompt: ${firstLine}`}
          className="min-w-0 flex-1 truncate rounded-xs px-1.5 py-0.5 text-left text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
        >
          {firstLine}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-xs" onClick={onPrevious} aria-label="Previous prompt">
                <ChevronUp aria-hidden="true" />
              </Button>
            }
          />
          <TooltipContent>{`Previous prompt (${shortcutLabel(APP_SHORTCUTS.previousPrompt, os)})`}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-xs" onClick={onNext} aria-label="Next prompt">
                <ChevronDown aria-hidden="true" />
              </Button>
            }
          />
          <TooltipContent>{`Next prompt (${shortcutLabel(APP_SHORTCUTS.nextPrompt, os)})`}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
