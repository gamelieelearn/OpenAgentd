/**
 * Workbench layout geometry for the desktop coding cockpit.
 *
 * Pure functions only — the persisted values live in ``useLayoutStore`` and
 * the measured widths come from the shell. Keeping the math here lets the
 * sidebar and the review dock agree on one budget instead of each querying
 * the other's DOM node while rendering.
 *
 *   ┌ sidebar ┬──────────── center ────────────┐
 *   │  264px  │  chat (≥ CHAT_MIN) │ dock (≥ DOCK_MIN) │
 *
 * The dock stores a *ratio* of the center rather than pixels (Zed's
 * "flexible" docks), so it scales with the window instead of pinning a
 * width chosen on a smaller screen.
 */

export const SIDEBAR_DEFAULT_WIDTH = 264
export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 440
/** Viewports at least this wide open with the sidebar expanded on first run. */
export const SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT = 1280

/** Narrowest chat column kept beside an open dock. */
export const CHAT_MIN_WIDTH = 400
export const DOCK_MIN_WIDTH = 340
export const DOCK_DEFAULT_RATIO = 0.45

/** Keyboard resize steps for panel separators. */
export const RESIZE_KEY_STEP = 16
export const RESIZE_KEY_STEP_LARGE = 64

export type DockMode = 'side' | 'overlay'

export interface DockLayout {
  mode: DockMode
  width: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** First-run default: expanded on wide windows, collapsed otherwise. */
export function resolveSidebarCollapsed(stored: boolean | null | undefined, viewportWidth: number): boolean {
  if (typeof stored === 'boolean') return stored
  return viewportWidth < SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT
}

/** Largest sidebar that still leaves room for the chat and a side dock. */
export function sidebarMaxWidth(viewportWidth: number): number {
  return clamp(viewportWidth - CHAT_MIN_WIDTH - DOCK_MIN_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const safe = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH
  return Math.round(clamp(safe, SIDEBAR_MIN_WIDTH, sidebarMaxWidth(viewportWidth)))
}

/** Center widths below this cannot fit the chat and the dock side by side. */
export const DOCK_SIDE_BY_SIDE_MIN_CENTER = CHAT_MIN_WIDTH + DOCK_MIN_WIDTH

export function dockMaxWidth(centerWidth: number): number {
  return Math.max(DOCK_MIN_WIDTH, centerWidth - CHAT_MIN_WIDTH)
}

/**
 * Resolve the dock's geometry. ``overlay`` covers the chat column — used for
 * the explicit maximize toggle and as the fallback when the window is too
 * narrow for a usable side-by-side split.
 */
export function resolveDockLayout({
  centerWidth,
  ratio,
  maximized,
}: {
  centerWidth: number
  ratio: number
  maximized: boolean
}): DockLayout {
  const center = Math.max(0, Math.round(centerWidth))
  if (maximized || center < DOCK_SIDE_BY_SIDE_MIN_CENTER) {
    return { mode: 'overlay', width: center }
  }
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DOCK_DEFAULT_RATIO
  return {
    mode: 'side',
    width: Math.round(clamp(safeRatio * center, DOCK_MIN_WIDTH, dockMaxWidth(center))),
  }
}

export function ratioFromWidth(width: number, centerWidth: number): number {
  if (!(centerWidth > 0) || !Number.isFinite(width)) return DOCK_DEFAULT_RATIO
  return clamp(width / centerWidth, 0.05, 0.95)
}
