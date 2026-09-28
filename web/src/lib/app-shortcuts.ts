/**
 * The app's keyboard shortcuts, in one table.
 *
 * Registration (``useHotkey`` / ``useHotkeys`` accept the ``RawHotkey`` from
 * ``hotkeyOf``), labels in tooltips and the command palette, and synthetic
 * dispatch from palette items or native menu commands all read from here, so
 * a key changes in one place. Every shortcut uses the platform's primary
 * modifier (⌘ on macOS, Ctrl elsewhere); see ``keyboard-shortcut.ts``.
 */
import type { RawHotkey } from '@tanstack/react-hotkeys'

import type { OS } from '@/hooks/use-platform'
import { dispatchShortcutKey, formatShortcut } from '@/lib/keyboard-shortcut'

export interface AppShortcut {
  key: string
  shift?: boolean
  alt?: boolean
}

export const APP_SHORTCUTS = {
  newSession: { key: 'N' },
  // Shift dodges bare ⌘A (Select All).
  sessionSettings: { key: 'A', shift: true },
  findInTranscript: { key: 'F' },
  workspaceFiles: { key: 'D' },
  maximizeDock: { key: 'D', shift: true },
  tasks: { key: 'T' },
  quickOpen: { key: 'P' },
  commandPalette: { key: 'K' },
  sidebar: { key: 'B' },
  focusChat: { key: 'I' },
  closeTab: { key: 'W' },
  settings: { key: ',' },
  historyBack: { key: '[' },
  historyForward: { key: ']' },
  // Alt keeps bare ⌘↑/⌘↓ for the caret and scroll-to-end they already mean.
  previousPrompt: { key: 'ArrowUp', alt: true },
  nextPrompt: { key: 'ArrowDown', alt: true },
  // Matched on the physical Backquote key by a custom listener: layouts report
  // Shift+` as `~`, `` ` `` or `Dead`, which a character hotkey cannot express.
  terminal: { key: '`', shift: true },
} as const satisfies Record<string, AppShortcut>

/** Registerable form for ``useHotkey`` / ``useHotkeys``. */
export function hotkeyOf(shortcut: AppShortcut): RawHotkey {
  const hotkey: RawHotkey = { key: shortcut.key, mod: true, shift: shortcut.shift ?? false }
  if (shortcut.alt) hotkey.alt = true
  return hotkey
}

/** Human-readable label, e.g. ``⌘⇧D`` or ``Ctrl+Shift+D``. */
export function shortcutLabel(shortcut: AppShortcut, os: OS): string {
  return formatShortcut(shortcut.key, os, { shift: shortcut.shift, alt: shortcut.alt })
}

/** Fire the shortcut as a synthetic key press (palette items, native menus). */
export function dispatchAppShortcut(shortcut: AppShortcut, os: OS): void {
  dispatchShortcutKey(shortcut.key.toLowerCase(), os, { shift: shortcut.shift })
}
