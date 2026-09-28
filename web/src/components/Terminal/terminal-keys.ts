/**
 * Keys a focused terminal keeps for itself.
 *
 * App shortcuts listen on ``document`` and fire regardless of focus, so a key
 * the terminal owns has to stop propagating at the terminal. xterm already
 * does that for every key it sends to the shell (so Ctrl+D, Ctrl+W, Ctrl+R…
 * never reach app shortcuts on Windows/Linux), but it ignores ⌘ combinations
 * on macOS. There ⌘K clears the scrollback (Terminal.app, iTerm, VS Code)
 * instead of opening the palette, and ⌘F stays put instead of pulling the
 * user out to the transcript find bar. Both also ``preventDefault`` so the
 * native menu accelerator for the same key does not fire.
 */
import type { OS } from '@/hooks/use-platform'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'

/**
 * xterm custom key handler body: returns ``false`` when the key was handled
 * here and xterm must not process it.
 */
export function routeTerminalKey(event: KeyboardEvent, os: OS, clear: () => void): boolean {
  if (event.type !== 'keydown' || !isPrimaryModifierOS(os)) return true
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true
  const key = event.key.toLowerCase()
  if (key === 'k') {
    event.preventDefault()
    event.stopPropagation()
    clear()
    return false
  }
  if (key === 'f') {
    event.preventDefault()
    event.stopPropagation()
    return false
  }
  return true
}
