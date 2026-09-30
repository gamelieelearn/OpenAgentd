import { describe, expect, it } from 'bun:test'

import { formatChord } from '@/lib/keyboard/chord'
import { shortcutHelp } from '@/lib/keyboard/help'

const find = (os: 'macos' | 'windows', label: string) =>
  shortcutHelp(os).flatMap((group) => group.entries).find((entry) => entry.label === label)

describe('formatChord', () => {
  it('formats any chord for each platform', () => {
    expect(formatChord({ key: 'W', mod: true }, 'macos')).toBe('⌘W')
    expect(formatChord({ key: 'W', mod: true }, 'windows')).toBe('Ctrl+W')
    expect(formatChord({ key: 'Enter', alt: true }, 'macos')).toBe('⌥↵')
    expect(formatChord({ key: 'Enter', shift: true }, 'linux')).toBe('Shift+Enter')
    expect(formatChord({ key: 'C', code: 'KeyC', alt: true }, 'windows')).toBe('Alt+C')
    expect(formatChord({ key: 'Escape' }, 'macos')).toBe('Esc')
  })
})

describe('shortcutHelp', () => {
  it('groups the app table and the keys that live in one area', () => {
    const groups = shortcutHelp('macos').map((group) => group.title)
    expect(groups).toEqual(['App', 'Chat', 'Review dock', 'Terminal', 'Preview', 'Dialogs and viewers'])
    expect(find('macos', 'Close tab')?.keys).toEqual(['⌘W'])
    expect(find('windows', 'Close tab')?.keys).toEqual(['Ctrl+W'])
    expect(find('macos', 'Keyboard shortcuts')?.keys).toEqual(['⌘/'])
    expect(find('macos', 'Toggle Design picking')?.keys).toEqual(['⌥C'])
    expect(find('macos', 'Close the top dialog, menu or viewer')?.keys).toEqual(['Esc'])
  })

  it('lists every app shortcut once', () => {
    const labels = shortcutHelp('linux').flatMap((group) => group.entries.map((entry) => entry.label))
    expect(new Set(labels).size).toBe(labels.length)
  })
})
