import { describe, expect, it, mock } from 'bun:test'

import { routeTerminalKey } from '@/components/Terminal/terminal-keys'

function keydown(key: string, mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}) {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
}

/** Whether an app shortcut listening on ``document`` would still see the key. */
function reachesDocument(event: KeyboardEvent, os: 'macos' | 'linux', clear = () => {}) {
  const target = document.createElement('textarea')
  document.body.appendChild(target)
  let reached = false
  const listener = () => { reached = true }
  document.addEventListener('keydown', listener)
  target.addEventListener('keydown', (e) => routeTerminalKey(e, os, clear))
  target.dispatchEvent(event)
  document.removeEventListener('keydown', listener)
  target.remove()
  return reached
}

describe('routeTerminalKey — macOS', () => {
  it('clears the terminal on ⌘K instead of opening the command palette', () => {
    const clear = mock(() => {})
    const event = keydown('k', { metaKey: true })
    expect(reachesDocument(event, 'macos', clear)).toBe(false)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('keeps ⌘F in the terminal rather than jumping to the transcript find bar', () => {
    const event = keydown('f', { metaKey: true })
    expect(reachesDocument(event, 'macos')).toBe(false)
    // Also claims it from the native Edit ▸ Find accelerator.
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets other app shortcuts through', () => {
    expect(reachesDocument(keydown('p', { metaKey: true }), 'macos')).toBe(true)
    expect(reachesDocument(keydown('d', { metaKey: true, shiftKey: true }), 'macos')).toBe(true)
  })

  it('leaves Ctrl+letter alone: it never collides with ⌘ shortcuts', () => {
    expect(reachesDocument(keydown('k', { ctrlKey: true }), 'macos')).toBe(true)
  })
})

describe('routeTerminalKey — Windows/Linux', () => {
  it('leaves every key to xterm, which already stops the ones it sends to the shell', () => {
    const clear = mock(() => {})
    expect(reachesDocument(keydown('k', { ctrlKey: true }), 'linux', clear)).toBe(true)
    expect(clear).not.toHaveBeenCalled()
  })
})

it('ignores keyup and keypress', () => {
  const clear = mock(() => {})
  const event = new KeyboardEvent('keyup', { key: 'k', metaKey: true })
  expect(routeTerminalKey(event, 'macos', clear)).toBe(true)
  expect(clear).not.toHaveBeenCalled()
})
