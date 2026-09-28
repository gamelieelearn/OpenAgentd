/**
 * Focus handoff between the chat and a review dock that can cover it.
 *
 * When the dock covers the chat (maximized, or a narrow window), the chat
 * column becomes ``inert`` and the browser drops any focus inside it onto
 * ``<body>``. DESIGN.md requires a visible replacement, so the dock claims
 * that stranded focus, and the shell hands it back to the composer when the
 * dock closes or stops covering the chat.
 */
import { useEffect, useRef } from 'react'

/** Focus sits nowhere useful: on ``<body>``, or inside an inert subtree. */
export function isFocusStranded(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return !active || active === document.body || active.closest('[inert]') !== null
}

/**
 * While ``active``, move stranded focus to ``getTarget()``. ``key`` re-runs the
 * check when the target changes (for example another tab becomes active);
 * focus the user placed on a live control is never taken.
 */
export function useClaimStrandedFocus(active: boolean, key: string, getTarget: () => HTMLElement | null) {
  const getTargetRef = useRef(getTarget)
  useEffect(() => {
    getTargetRef.current = getTarget
  })
  useEffect(() => {
    if (!active || !isFocusStranded()) return
    getTargetRef.current()?.focus({ preventScroll: true })
  }, [active, key])
}

interface ReturnFocusOptions {
  open: boolean
  /** The dock covers the chat, which is inert underneath. */
  covered: boolean
  enabled: boolean
  isInDock: (element: Element) => boolean
  onReturn: () => void
}

/**
 * Call ``onReturn`` when the dock closes with focus inside it (it may still be
 * animating out), and when a dock that covered the chat closes or uncovers it
 * while focus is stranded. Focus the user moved elsewhere, such as the header
 * toggle, stays — and so does focus on ``<body>`` beside a side-by-side dock:
 * it sat there before the dock opened, so the dock stranded nothing.
 */
export function useReturnFocusFromDock({ open, covered, enabled, isInDock, onReturn }: ReturnFocusOptions) {
  const previousRef = useRef({ open, covered })
  const callbacksRef = useRef({ isInDock, onReturn })
  useEffect(() => {
    callbacksRef.current = { isInDock, onReturn }
  })
  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { open, covered }
    if (!enabled) return
    const closed = previous.open && !open
    const uncovered = previous.covered && !covered
    if (!closed && !uncovered) return
    const active = document.activeElement
    const leavingDock = closed && active !== null && callbacksRef.current.isInDock(active)
    const strandedByDock = previous.covered && isFocusStranded()
    if (leavingDock || strandedByDock) callbacksRef.current.onReturn()
  }, [open, covered, enabled])
}
