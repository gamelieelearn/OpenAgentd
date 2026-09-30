import { useRouter } from '@tanstack/react-router'
import { appShortcut, useShortcuts } from '@/lib/keyboard/hooks'

/**
 * ``⌘[`` / ``⌘]`` (``Ctrl+[`` / ``Ctrl+]`` on Windows/Linux) — step
 * backward/forward through the app's own navigation history, mirroring
 * the identical shortcut in every major desktop browser (Safari, Chrome,
 * Edge).
 *
 * This drives the router's history stack directly (``router.history``,
 * TanStack Router's wrapper around the real ``window.history``), so it
 * works the same everywhere in the app — settings, telemetry, workspaces and
 * sessions alike. Registered once, globally, in
 * ``__root.tsx``.
 */
export function useHistoryBackForwardShortcuts(): void {
  const router = useRouter()
  useShortcuts([
    appShortcut('historyBack', () => { router.history.back() }),
    appShortcut('historyForward', () => { router.history.forward() }),
  ])
}
