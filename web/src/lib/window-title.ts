import { workspaceLabel } from '@/utils/workspace'
import { getPlatform } from '@/hooks/use-platform'

const APP_NAME = 'OpenAgentd'

export function buildDesktopWindowTitle(options: {
  workspace?: string | null
  sessionTitle?: string | null
  /** Display label for the workspace; defaults to its basename. */
  workspaceName?: string | null
  /** Sessions waiting on the user; shown as a ``(n)`` prefix. */
  needsYou?: number
}): string {
  const base = baseTitle(options)
  return options.needsYou ? `(${options.needsYou}) ${base}` : base
}

function baseTitle(options: { workspace?: string | null; sessionTitle?: string | null; workspaceName?: string | null }): string {
  const title = options.sessionTitle?.trim()
  if (title) return title
  const name = options.workspaceName?.trim()
  if (name) return name
  if (options.workspace) {
    return workspaceLabel(options.workspace)
  }
  return APP_NAME
}

/**
 * Sync the browser tab title from the current session/workspace state.
 *
 * Only updates `document.title` — we intentionally do NOT call
 * `NSWindow.setTitle` on macOS Tauri because it triggers an AppKit
 * titlebar relayout that resets the traffic-light vertical position.
 * The native window title stays as "OpenAgentd" (set at build time in
 * `configure_window_chrome`) and is invisible to the user inside the app.
 */
export function syncDesktopWindowTitle(options: {
  workspace?: string | null
  sessionTitle?: string | null
  workspaceName?: string | null
  needsYou?: number
}): void {
  const title = buildDesktopWindowTitle(options)
  if (typeof document !== 'undefined') document.title = title
}

/**
 * Badge the app icon (the macOS dock) with the number of sessions waiting on
 * the user; zero clears it. Every window sets the same count, so the last
 * one to update wins without disagreeing.
 */
export async function syncDesktopBadgeCount(count: number): Promise<void> {
  if (!getPlatform().isTauri) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined)
  } catch (err) {
    // Windows has no badge API, and a badge is never worth an error.
    console.debug('app badge update failed', err)
  }
}
