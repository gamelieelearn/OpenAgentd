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
 * The trace is secondary to the answer, so a finished one folds to a single
 * row in the tool-call row language. It stays open while it streams (that is
 * the only sign of progress), and once the reader toggles it, their choice
 * wins over both defaults.
 */
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { splitSections } from '@/utils/thinking'
import { useSmoothStream } from '@/hooks/useSmoothStream'
import { cn } from '@/lib/utils'

interface ThinkingProps {
  content: string
  isStreaming?: boolean
  /** Show the trace whatever the toggle says — e.g. find has a match inside it. */
  forceOpen?: boolean
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0]?.trim() ?? ''
}

export function Thinking({ content, isStreaming = false, forceOpen = false }: ThinkingProps) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const bodyId = useId()
  const smoothedContent = useSmoothStream(content, isStreaming)
  if (!content.trim()) return null

  const sections = splitSections(smoothedContent)
  const headers = sections.flatMap((section) => (section.header ? [section.header] : []))
  // While streaming, the newest header says what the model is doing now; once
  // finished, the first one reads as the trace's title.
  const summary = (isStreaming ? headers.at(-1) : headers[0]) ?? firstLine(content)
  const open = forceOpen || (manualOpen ?? isStreaming)
  const label = isStreaming ? 'Thinking' : 'Thought'

  return (
    <div className="my-2 min-w-0">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        data-find-skip
        className="group inline-flex max-w-full items-center gap-1.5 py-1 text-left text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
      >
        <span className={cn('min-w-0 truncate font-mono', isStreaming && 'animate-pulse motion-reduce:animate-none')}>
          <span className="font-semibold">{label}</span>
          {summary && <span>: {summary}</span>}
        </span>
        <ChevronRight
          size={13}
          aria-hidden
          className={cn('shrink-0 transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div
          id={bodyId}
          className="mt-1 min-w-0 space-y-2 border-l border-(--color-border) pl-3 font-mono text-xs leading-relaxed text-(--color-text-2) [overflow-wrap:anywhere]"
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
