import { useEffect, useState, type RefObject } from 'react'

/**
 * Track an element's rendered width. Falls back to the window width when the
 * element has no layout yet (first paint, test DOMs) or ResizeObserver is
 * unavailable, and coalesces bursts (e.g. a sidebar width tween) to one
 * update per animation frame.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))

  useEffect(() => {
    const node = ref.current
    if (typeof window === 'undefined') return
    let frame: number | null = null
    const measure = () => {
      frame = null
      const measured = node?.getBoundingClientRect().width ?? 0
      const next = Math.round(measured > 0 ? measured : window.innerWidth)
      setWidth((prev) => (prev === next ? prev : next))
    }
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(measure)
    }
    measure()
    let observer: ResizeObserver | null = null
    if (node && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(node)
    }
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [ref])

  return width
}
