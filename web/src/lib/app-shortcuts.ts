/**
 * The app's keyboard shortcuts, in one table.
 *
 * Registration (``useAppShortcut`` / ``appShortcut`` in ``lib/keyboard``),
 * labels in tooltips and the command palette, the chords swallowed behind
 * dialogs, and synthetic dispatch from native menu commands all read from
 * here, so a key changes in one place. Every shortcut uses the platform's
 * primary modifier (⌘ on macOS, Ctrl elsewhere); see ``keyboard-shortcut.ts``.
 */
import type { OS } from '@/hooks/use-platform'
import { dispatchShortcutKey, formatShortcut } from '@/lib/keyboard-shortcut'
import type { KeyChord } from '@/lib/keyboard/chord'

export interface AppShortcut {
  key: string
  /** Match the physical key (layouts that print another character). */
  code?: string
  shift?: boolean
  alt?: boolean
  /** May replace an open overlay instead of being blocked by it. */
  switcher?: boolean
}

export const APP_SHORTCUTS = {
  newSession: { key: 'N' },
  // Shift dodges bare ⌘A (Select All).
  sessionSettings: { key: 'A', shift: true },
  findInTranscript: { key: 'F' },
  workspaceFiles: { key: 'D' },
  maximizeDock: { key: 'D', shift: true },
  tasks: { key: 'T' },
  quickOpen: { key: 'P', switcher: true },
  commandPalette: { key: 'K', switcher: true },
  sidebar: { key: 'B' },
  focusChat: { key: 'I' },
  closeTab: { key: 'W' },
  settings: { key: ',', switcher: true },
  historyBack: { key: '[' },
  historyForward: { key: ']' },
  // Alt keeps bare ⌘↑/⌘↓ for the caret and scroll-to-end they already mean.
  previousPrompt: { key: 'ArrowUp', alt: true },
  nextPrompt: { key: 'ArrowDown', alt: true },
  // Matched on the physical Backquote key: layouts report Shift+` as `~`,
  // `` ` `` or `Dead`, which a character match cannot express.
  terminal: { key: '`', code: 'Backquote', shift: true },
  shortcutsHelp: { key: '/', switcher: true },
} as const satisfies Record<string, AppShortcut>

export type AppShortcutName = keyof typeof APP_SHORTCUTS

/** The chord the keyboard dispatcher matches for a shortcut. */
export function chordOf(shortcut: AppShortcut): KeyChord {
  const chord: KeyChord = { key: shortcut.key, mod: true, alt: shortcut.alt ?? false }
  // A symbol key leaves Shift open: some layouts need it to type "/" or "[".
  const symbol = !shortcut.code && shortcut.key.length === 1 && !/[a-z0-9]/i.test(shortcut.key)
  if (shortcut.shift !== undefined || !symbol) chord.shift = shortcut.shift ?? false
  if (shortcut.code) chord.code = shortcut.code
  return chord
}

/** Every app chord: swallowed behind dialogs even when nothing handles it. */
export const APP_SHORTCUT_CHORDS: readonly KeyChord[] = Object.values(APP_SHORTCUTS).map((s) => chordOf(s))

/** Human-readable label, e.g. ``⌘⇧D`` or ``Ctrl+Shift+D``. */
export function shortcutLabel(shortcut: AppShortcut, os: OS): string {
  return formatShortcut(shortcut.key, os, { shift: shortcut.shift, alt: shortcut.alt })
}

/** Fire the shortcut as a synthetic key press (palette items, native menus). */
export function dispatchAppShortcut(shortcut: AppShortcut, os: OS): void {
  dispatchShortcutKey(shortcut.key.toLowerCase(), os, { shift: shortcut.shift, alt: shortcut.alt, code: shortcut.code })
}
