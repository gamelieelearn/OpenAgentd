/**
 * Dynamic Type for the iOS app. WKWebView resolves ``font:
 * -apple-system-body`` to the body text style at the user's text size
 * (Settings > Display & Brightness > Text Size, or Control Center) and
 * re-resolves it when that changes. The mobile shell blocks pinch zoom, so
 * this is how someone who needs larger text gets it.
 *
 * The root font size scales by the body size relative to the iOS default,
 * so rem-sized type and spacing grow together and layouts keep their
 * proportions. It never shrinks below the design size (the 11px floor in
 * DESIGN.md assumes it), and it stops at ``MAX_DYNAMIC_TYPE_SCALE``, past
 * which a 375pt phone has under 300 CSS px of width. Type set in px (fine
 * metadata) keeps its size.
 *
 * Root font size rather than CSS ``zoom``: zoom would also scale the px
 * geometry the keyboard handling writes (``--app-vh``).
 */

/** ``-apple-system-body`` at iOS's default text size ("Large"). */
export const IOS_DEFAULT_BODY_PX = 17
export const MAX_DYNAMIC_TYPE_SCALE = 1.25
const DESIGN_ROOT_PX = 16

export function dynamicTypeScale(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 1
  return Math.min(MAX_DYNAMIC_TYPE_SCALE, Math.max(1, bodyPx / IOS_DEFAULT_BODY_PX))
}

/** Follow the user's text size on ``root`` until the returned cleanup runs. */
export function followDynamicType(root: HTMLElement = document.documentElement): () => void {
  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.setAttribute('data-dynamic-type-probe', '')
  probe.textContent = 'M'
  probe.style.cssText =
    'position:absolute;top:0;left:-9999px;visibility:hidden;pointer-events:none;white-space:nowrap;font:-apple-system-body'
  document.body.appendChild(probe)

  const apply = () => {
    const scale = dynamicTypeScale(parseFloat(window.getComputedStyle(probe).fontSize))
    if (scale === 1) root.style.removeProperty('font-size')
    else root.style.setProperty('font-size', `${DESIGN_ROOT_PX * scale}px`)
  }
  apply()

  // The probe's box changes size when WebKit re-resolves the text style,
  // which covers the Control Center slider while the app stays visible.
  // Returning from Settings is caught by visibilitychange as well.
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
  observer?.observe(probe)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') apply()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    observer?.disconnect()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    probe.remove()
    root.style.removeProperty('font-size')
  }
}
