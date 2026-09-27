import { useEffect, useState, type Ref } from 'react'
import type { ContentBlock } from '@/api/types'
import { useDocumentVisible } from '@/hooks/use-document-visible'
import { useAgentStore } from '@/stores/useAgentStore'
import { useUnreadStore } from '@/stores/useUnreadStore'

/**
 * The block the "New" line goes before: the first one after the newest
 * block this session had on screen last time. Decided once per visit, as
 * soon as the session's history has loaded, so content that streams in while
 * you watch never gets a line. While the window is visible, the newest block
 * is recorded as seen.
 */
export function useNewSinceLastVisit(blocks: ContentBlock[]): string | null {
  const sessionId = useAgentStore((s) => s.sessionId)
  const historyLoaded = useAgentStore((s) => s._syncedThrough !== null)
  const visible = useDocumentVisible()
  const [visit, setVisit] = useState<{ sessionId: string; beforeId: string | null } | null>(null)
  const ready = sessionId !== null && historyLoaded && blocks.length > 0
  const decided = ready && visit?.sessionId === sessionId

  useEffect(() => {
    if (!ready || decided) return
    const seen = useUnreadStore.getState().lastSeen[sessionId]
    const index = seen ? blocks.findIndex((block) => block.id === seen) : -1
    setVisit({ sessionId, beforeId: index >= 0 ? (blocks[index + 1]?.id ?? null) : null })
  }, [blocks, decided, ready, sessionId])

  useEffect(() => {
    if (!decided || !visible) return
    useUnreadStore.getState().markSeen(sessionId, blocks[blocks.length - 1].id)
  }, [blocks, decided, sessionId, visible])

  return decided ? visit.beforeId : null
}

export function NewDivider({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-label="New since your last visit"
      className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-(--color-accent)"
    >
      <span className="h-px flex-1 bg-(--color-accent)/40" aria-hidden="true" />
      New
      <span className="h-px flex-1 bg-(--color-accent)/40" aria-hidden="true" />
    </div>
  )
}
