/**
 * ActivePlanSection — the session plan as one row above the task list.
 *
 * The lead writes the plan with the ``plan`` tool, and the backend restates it
 * after every context compaction. Open shows it in the Plan tab (View opens a
 * read-only document where there is no dock); Clear stops using it in the
 * session, so later compactions stop carrying a plan the session has moved
 * past. A workspace plan file stays on disk.
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
  /** Open the plan in the Plan tab. Without it, View opens a read-only document. */
  onOpen?: () => void
  clearing?: boolean
  className?: string
}

export function ActivePlanSection({ plan, onClear, onOpen, clearing = false, className }: ActivePlanSectionProps) {
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
  const approved = plan.approved_revision !== null && plan.approved_revision !== undefined && plan.approved_revision === plan.revision

  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-2.5 py-1', className)}>
      <FileText size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
      <span className="text-xs font-medium text-(--color-text)">Plan</span>
      {plan.revision !== undefined && (
        <span className="font-mono text-[11px] tabular-nums text-(--color-text-subtle)">rev {plan.revision}</span>
      )}
      {approved && <span className="text-[11px] font-medium text-(--accent-green-text)">Approved</span>}
      <span
        className="font-mono text-[11px] tabular-nums text-(--color-text-subtle)"
        title={`Updated ${formatRelativeDate(plan.updated_at)}`}
      >
        {formatCompactRelative(plan.updated_at)}
      </span>
      <span className="flex-1" aria-hidden="true" />
      {onOpen ? (
        <Button type="button" variant="ghost" size="xs" onClick={onOpen} aria-label="Open plan">
          Open
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="xs" onClick={openPlan} aria-label="View plan">
          View
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onClear}
        disabled={clearing}
        aria-label="Clear plan"
        title="Stops using this plan in the session; the file stays."
      >
        Clear
      </Button>
      {doc && <FileLightbox items={[doc]} isOpen onClose={closePlan} />}
    </div>
  )
}
