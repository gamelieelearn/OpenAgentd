/**
 * ActivePlanSection — the session's saved Plan-mode plan as one row above
 * the task list.
 *
 * The backend saves a Plan-mode turn's ``<proposed_plan>`` as ``plan.md`` and
 * restates it after every context compaction. View opens that file as a
 * document; Clear deletes it, so later compactions stop carrying a plan the
 * session has moved past. The rendered plan stays in the transcript.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import type { SessionPlan } from '@/api/types'
import { FileLightbox, type FileLightboxItem } from './FileLightbox'

export interface ActivePlanSectionProps {
  plan: SessionPlan
  onClear: () => void
  clearing?: boolean
  className?: string
}

export function ActivePlanSection({ plan, onClear, clearing = false, className }: ActivePlanSectionProps) {
  const [doc, setDoc] = useState<FileLightboxItem | null>(null)
  const urlRef = useRef<string | null>(null)
  const releaseUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
  }, [])
  useEffect(() => releaseUrl, [releaseUrl])

  const openPlan = () => {
    releaseUrl()
    urlRef.current = URL.createObjectURL(new Blob([plan.content], { type: 'text/markdown' }))
    setDoc({ type: 'text', src: urlRef.current, name: 'plan.md', textContent: plan.content })
  }
  const closePlan = () => {
    releaseUrl()
    setDoc(null)
  }

  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-2.5 py-1', className)}>
      <FileText size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
      <span className="text-xs font-medium text-(--color-text)">Plan</span>
      <span
        className="font-mono text-[11px] tabular-nums text-(--color-text-subtle)"
        title={`Updated ${formatRelativeDate(plan.updated_at)}`}
      >
        {formatCompactRelative(plan.updated_at)}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <Button type="button" variant="ghost" size="xs" onClick={openPlan} aria-label="View plan">
        View
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={onClear} disabled={clearing} aria-label="Clear plan">
        Clear
      </Button>
      {doc && <FileLightbox items={[doc]} isOpen onClose={closePlan} />}
    </div>
  )
}
