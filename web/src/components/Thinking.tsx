/**
 * Thinking — inline reasoning trace, as a disclosure row.
 *
 * Reasoning streams from providers like OpenAI's ``/responses`` API as a
 * sequence of sections, each beginning with a bold ``**Title**`` header.
 * ``splitSections`` (see ``@/utils/thinking``) parses the raw text into
 * ordered sections; each header is rendered as a styled run above its body.
 * Inline ``**bold**`` runs inside the body are NOT Markdown-rendered —
 * reasoning is rarely complex prose; only the section headers get emphasis.
 *
 * The trace is secondary to the answer. While it streams, a three-line
 * window shows its newest lines as the sign of progress; once finished it
 * folds to "Thought for Ns". Opening it shows the whole trace, and the
 * reader's toggle wins over both defaults.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { splitSections } from '@/utils/thinking'
import { useSmoothStream } from '@/hooks/useSmoothStream'
import { cn } from '@/lib/utils'

interface ThinkingProps {
  content: string
  isStreaming?: boolean
  /** How long the model thought; unknown for live traces still running. */
  durationMs?: number
  /** Show the whole trace whatever the toggle says — e.g. find matched in it. */
  forceOpen?: boolean
}

function formatThoughtTime(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function Thinking({ content, isStreaming = false, durationMs, forceOpen = false }: ThinkingProps) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const windowRef = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const smoothedContent = useSmoothStream(content, isStreaming)
  const open = forceOpen || (manualOpen ?? false)
  const showWindow = isStreaming && !open

  useLayoutEffect(() => {
    const el = windowRef.current
    setOverflowing(Boolean(el && el.scrollHeight > el.clientHeight))
  }, [showWindow, smoothedContent])

  if (!content.trim()) return null

  const sections = splitSections(smoothedContent)
  const label = isStreaming
    ? 'Thinking'
    : durationMs === undefined ? 'Thought' : `Thought for ${formatThoughtTime(durationMs)}`

  return (
    <div className="my-2 min-w-0 font-sans">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        data-find-skip
        className="group inline-flex max-w-full items-center gap-1 py-1 text-left text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
      >
        <span className={cn('truncate', isStreaming && 'animate-pulse motion-reduce:animate-none')}>{label}</span>
        <ChevronRight
          size={13}
          aria-hidden
          className={cn('shrink-0 transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
        />
      </button>
      {showWindow && (
        // Bottom-anchored: overflow spills off the top, so the newest lines
        // stay in view. Decorative; the whole trace is one toggle away.
        <div
          ref={windowRef}
          data-thinking-window
          aria-hidden
          className={cn(
            'flex max-h-[4.5em] flex-col justify-end overflow-hidden text-xs leading-normal whitespace-pre-wrap break-words text-(--color-text-muted) [overflow-wrap:anywhere]',
            overflowing && '[mask-image:linear-gradient(to_bottom,transparent,black_1.5em)]',
          )}
        >
          {sections.map((s) => [s.header, s.body].filter(Boolean).join('\n')).join('\n\n')}
        </div>
      )}
      {open && (
        <div
          id={bodyId}
          className="mt-1 min-w-0 space-y-2 border-l border-(--color-border) pl-3 text-xs leading-relaxed text-(--color-text-2) [overflow-wrap:anywhere]"
        >
          {sections.map((s, i) => (
            <div key={i} className="min-w-0">
              {s.header && (
                <p data-thinking-section-header className="mb-1 break-words font-semibold text-(--color-text) [overflow-wrap:anywhere]">{s.header}</p>
              )}
              {s.body && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{s.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
