/**
 * TranscriptViewMenu — the footer's "Aa" control for how the transcript
 * reads: density and text size. The palette offers the same settings, which
 * is how they are reached below ``md``.
 */
import { useState } from 'react'
import { ALargeSmall, Minus, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DEFAULT_TRANSCRIPT_FONT_SIZE,
  TRANSCRIPT_DENSITIES,
  TRANSCRIPT_FONT_SIZES,
  useTranscriptStore,
} from '@/stores/useTranscriptStore'
import { cn } from '@/lib/utils'

const STEP =
  'inline-flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 disabled:pointer-events-none disabled:opacity-40'

export function TranscriptViewMenu({ className }: {
  /** Trigger styling. */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const density = useTranscriptStore((s) => s.density)
  const fontSize = useTranscriptStore((s) => s.fontSize)
  const setDensity = useTranscriptStore((s) => s.setDensity)
  const stepFontSize = useTranscriptStore((s) => s.stepFontSize)
  const resetFontSize = useTranscriptStore((s) => s.resetFontSize)
  const sizes = TRANSCRIPT_FONT_SIZES as readonly number[]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Transcript view"
                className={className}
              >
                <ALargeSmall size={12} aria-hidden="true" />
              </button>
            }
          />
        </TooltipTrigger>
        {!open && <TooltipContent>Transcript view</TooltipContent>}
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[min(16rem,calc(100vw-1rem))] gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium text-(--color-text-muted)">Density</p>
          <div role="radiogroup" aria-label="Density" className="grid grid-cols-3 rounded-md border border-(--color-border-subtle) p-0.5">
            {TRANSCRIPT_DENSITIES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={density === value}
                onClick={() => setDensity(value)}
                className={cn(
                  'h-7 rounded-sm text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
                  density === value
                    ? 'bg-(--color-surface-2) text-(--color-text)'
                    : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-(--color-text-muted)">Text size</p>
          <div className="flex items-center gap-0.5">
            {fontSize !== DEFAULT_TRANSCRIPT_FONT_SIZE && (
              <button
                type="button"
                onClick={resetFontSize}
                aria-label="Reset text size"
                className="mr-1 inline-flex h-7 items-center rounded-sm px-1.5 text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
              >
                Reset
              </button>
            )}
            <button type="button" onClick={() => stepFontSize(-1)} disabled={fontSize <= sizes[0]} aria-label="Smaller text" className={STEP}>
              <Minus size={12} aria-hidden="true" />
            </button>
            <span aria-live="polite" className="w-10 text-center font-mono text-[11px] text-(--color-text)">{fontSize}px</span>
            <button type="button" onClick={() => stepFontSize(1)} disabled={fontSize >= sizes[sizes.length - 1]} aria-label="Larger text" className={STEP}>
              <Plus size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
