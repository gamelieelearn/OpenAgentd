/**
 * TimelineScrubber — an overview rail at the transcript's right edge that
 * stands in for its scrollbar from ``md`` up. The view is a thumb; marks
 * show where prompts, find matches, and a question waiting on the user sit.
 * Press or drag anywhere on it to scrub.
 *
 * Pointer-only and hidden from assistive tech: prompt navigation and find
 * cover the same ground from the keyboard.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { cn } from '@/lib/utils'
import { promptElements } from './prompt-nav'

type MarkKind = 'prompt' | 'find' | 'find-active' | 'question'

interface Mark {
  key: string
  kind: MarkKind
  /** Offset down the transcript, 0–1. */
  at: number
}

/** Later kinds paint over earlier ones where marks meet. */
const MARK_ORDER: Record<MarkKind, number> = { prompt: 0, find: 1, 'find-active': 2, question: 3 }

const MARK_CLASS: Record<MarkKind, string> = {
  prompt: 'h-0.5 w-1.5 bg-(--color-text-subtle)',
  find: 'h-0.5 w-2 bg-(--accent-orange)',
  'find-active': 'h-1 w-3 bg-(--accent-orange-text)',
  question: 'h-1 w-3 bg-(--color-accent)',
}

const ID_SEPARATOR = '\u0000'

function percent(fraction: number): string {
  return `${Math.round(fraction * 10_000) / 100}%`
}

export function TimelineScrubber({ scrollRef, contentRef, findBlockIds, activeFindBlockId }: {
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  /** Blocks holding a find match. */
  findBlockIds: readonly string[]
  activeFindBlockId: string | null
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<{ top: number; height: number } | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [dragging, setDragging] = useState(false)
  const measuredHeight = useRef(-1)
  /** Where on the thumb the pointer holds it, in px; null when not dragging. */
  const grab = useRef<number | null>(null)
  // A string, so a new array with the same ids does not re-measure.
  const findKey = findBlockIds.join(ID_SEPARATOR)

  const measureMarks = useCallback((root: HTMLElement) => {
    const height = root.scrollHeight
    measuredHeight.current = height
    if (height <= 0) {
      setMarks([])
      return
    }
    const origin = root.getBoundingClientRect().top - root.scrollTop
    const at = (el: Element) => Math.min(1, Math.max(0, (el.getBoundingClientRect().top - origin) / height))
    const next: Mark[] = promptElements(root).map((el) => ({ key: `prompt:${el.dataset.promptId}`, kind: 'prompt', at: at(el) }))
    if (findKey) {
      const wanted = new Set(findKey.split(ID_SEPARATOR))
      for (const el of root.querySelectorAll<HTMLElement>('[data-find-block]')) {
        const id = el.dataset.findBlock
        if (!id || !wanted.has(id)) continue
        next.push({ key: `find:${id}`, kind: id === activeFindBlockId ? 'find-active' : 'find', at: at(el) })
      }
    }
    const question = root.querySelector('[data-question-waiting]')
    if (question) next.push({ key: 'question', kind: 'question', at: at(question) })
    setMarks(next)
  }, [activeFindBlockId, findKey])

  /** Moves the thumb; marks are re-measured when forced or the height changed. */
  const sync = useCallback((force: boolean) => {
    const root = scrollRef.current
    if (!root) return
    const { scrollHeight, clientHeight, scrollTop } = root
    if (force || scrollHeight !== measuredHeight.current) measureMarks(root)
    setView(scrollHeight > clientHeight + 1 ? { top: scrollTop / scrollHeight, height: clientHeight / scrollHeight } : null)
  }, [measureMarks, scrollRef])

  useEffect(() => {
    sync(true)
  }, [sync])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => sync(false)
    root.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => sync(true))
    observer?.observe(root)
    if (contentRef.current) observer?.observe(contentRef.current)
    return () => {
      root.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [contentRef, scrollRef, sync])

  const scrubTo = (clientY: number) => {
    const root = scrollRef.current
    const rail = railRef.current?.getBoundingClientRect()
    if (!root || !rail || rail.height <= 0 || grab.current === null) return
    root.scrollTop = ((clientY - rail.top - grab.current) / rail.height) * root.scrollHeight
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const thumb = thumbRef.current?.getBoundingClientRect()
    const onThumb = thumb !== undefined && event.clientY >= thumb.top && event.clientY <= thumb.bottom
    // Held by the thumb, it stays under the pointer; elsewhere the view centres there.
    grab.current = onThumb ? event.clientY - thumb.top : (thumb?.height ?? 0) / 2
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    setDragging(true)
    scrubTo(event.clientY)
  }

  const endDrag = () => {
    grab.current = null
    setDragging(false)
  }

  // The rail sits beside the scroller, not in it, so a wheel over it is passed on.
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const root = scrollRef.current
    if (!root) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1
    root.scrollTop += event.deltaY * unit
  }

  const orderedMarks = useMemo(() => [...marks].sort((a, b) => MARK_ORDER[a.kind] - MARK_ORDER[b.kind]), [marks])

  if (!view) return null

  return (
    <div
      ref={railRef}
      aria-hidden="true"
      data-transcript-scrubber=""
      className="group/scrubber absolute inset-y-0 right-0 z-10 hidden w-3 touch-none select-none md:block"
      onPointerDown={onPointerDown}
      onPointerMove={(event) => scrubTo(event.clientY)}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onWheel={onWheel}
    >
      <div
        ref={thumbRef}
        data-scrubber-thumb=""
        className={cn(
          'absolute inset-x-0.5 rounded-full bg-(--color-border) transition-opacity duration-(--motion-fast) group-hover/scrubber:bg-(--color-text-muted)',
          dragging ? 'opacity-100' : 'opacity-0 group-hover/transcript:opacity-100',
        )}
        style={{
          top: `calc(min(${percent(view.top)}, 100% - max(${percent(view.height)}, 1.5rem)))`,
          height: `calc(max(${percent(view.height)}, 1.5rem))`,
        }}
      />
      {orderedMarks.map((mark) => (
        <span
          key={mark.key}
          data-scrubber-mark={mark.kind}
          className={cn('pointer-events-none absolute right-0 rounded-full', MARK_CLASS[mark.kind])}
          style={{ top: `calc(min(${percent(mark.at)}, 100% - 0.25rem))` }}
        />
      ))}
    </div>
  )
}
