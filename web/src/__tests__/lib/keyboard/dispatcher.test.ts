/**
 * The keyboard dispatcher: one listener that routes each key press to the
 * top layer, a focused region, or an app shortcut — first match wins.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { getPlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, dispatchAppShortcut } from '@/lib/app-shortcuts'
import { isImeComposing, matchChord } from '@/lib/keyboard/chord'
import { _resetKeyboardForTests, registerShortcut } from '@/lib/keyboard/dispatcher'
import { pushLayer, removeLayer, topLayer } from '@/lib/keyboard/layers'

const mac = getPlatform().os === 'macos'
const MOD = mac ? { metaKey: true } : { ctrlKey: true }

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  _resetKeyboardForTests()
  document.body.innerHTML = ''
})

describe('matchChord', () => {
  const event = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

  it('uses ⌘ on macOS and Ctrl elsewhere, never both', () => {
    const chord = { key: 'K', mod: true }
    expect(matchChord(event({ key: 'k', metaKey: true }), chord, 'macos')).toBe(true)
    expect(matchChord(event({ key: 'k', ctrlKey: true }), chord, 'macos')).toBe(false)
    expect(matchChord(event({ key: 'k', ctrlKey: true }), chord, 'windows')).toBe(true)
    expect(matchChord(event({ key: 'k', ctrlKey: true, metaKey: true }), chord, 'windows')).toBe(false)
    expect(matchChord(event({ key: 'k' }), chord, 'windows')).toBe(false)
  })

  it('requires the exact Shift and Alt state, except Shift on printed symbols', () => {
    expect(matchChord(event({ key: 'D', ctrlKey: true, shiftKey: true }), { key: 'D', mod: true }, 'linux')).toBe(false)
    expect(matchChord(event({ key: 'D', ctrlKey: true, shiftKey: true }), { key: 'D', mod: true, shift: true }, 'linux')).toBe(true)
    expect(matchChord(event({ key: 'ArrowUp', ctrlKey: true }), { key: 'ArrowUp', mod: true, alt: true }, 'linux')).toBe(false)
    // "+" is Shift+= on US layouts.
    expect(matchChord(event({ key: '+', shiftKey: true }), { key: '+' }, 'linux')).toBe(true)
  })

  it('matches the physical key when a code is given', () => {
    // ⌥C types "ç" on macOS; Shift+` is "~" or a dead key on many layouts.
    expect(matchChord(event({ key: 'ç', code: 'KeyC', altKey: true }), { key: 'C', code: 'KeyC', alt: true }, 'macos')).toBe(true)
    expect(matchChord(event({ key: 'Dead', code: 'Backquote', ctrlKey: true, shiftKey: true }), { key: '`', code: 'Backquote', mod: true, shift: true }, 'linux')).toBe(true)
  })

  it('spots IME composition', () => {
    expect(isImeComposing(event({ key: 'Enter', isComposing: true }))).toBe(true)
    expect(isImeComposing(event({ key: 'Enter', keyCode: 229 } as KeyboardEventInit))).toBe(true)
    expect(isImeComposing(event({ key: 'Enter' }))).toBe(false)
  })
})

describe('keyboard dispatcher', () => {
  it('runs an app shortcut and claims the key', () => {
    const handler = mock(() => {})
    registerShortcut({ key: 'N', mod: true }, handler)
    const event = press(document.body, { key: 'n', ...MOD })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('skips keys an element already handled, and IME composition', () => {
    const handler = mock(() => {})
    registerShortcut({ key: 'Enter' }, handler)
    const button = document.body.appendChild(document.createElement('button'))
    button.addEventListener('keydown', (e) => e.preventDefault())
    press(button, { key: 'Enter' })
    press(document.body, { key: 'Enter', isComposing: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets the latest registration win, and falls through when it declines', () => {
    const calls: string[] = []
    registerShortcut({ key: 'B', mod: true }, () => { calls.push('first') })
    const second = registerShortcut({ key: 'B', mod: true }, () => { calls.push('second'); return false })
    press(document.body, { key: 'b', ...MOD })
    expect(calls).toEqual(['second', 'first'])
    second()
    press(document.body, { key: 'b', ...MOD })
    expect(calls).toEqual(['second', 'first', 'first'])
  })

  it('skips disabled shortcuts', () => {
    const handler = mock(() => {})
    registerShortcut({ key: 'T', mod: true }, handler, () => ({ enabled: false }))
    expect(press(document.body, { key: 't', ...MOD }).defaultPrevented).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('closes only the top layer on Escape', () => {
    const closed: string[] = []
    pushLayer({ kind: 'dialog', close: () => closed.push('dialog') })
    const popover = pushLayer({ kind: 'transient', close: () => closed.push('popover') })
    const event = press(document.body, { key: 'Escape' })
    expect(closed).toEqual(['popover'])
    expect(event.defaultPrevented).toBe(true)
    removeLayer(popover)
    press(document.body, { key: 'Escape' })
    expect(closed).toEqual(['popover', 'dialog'])
  })

  it('blocks and swallows app shortcuts behind a dialog', () => {
    const handler = mock(() => {})
    registerShortcut({ key: 'N', mod: true }, handler)
    pushLayer({ kind: 'dialog', close: () => {} })
    const event = press(document.body, { key: 'n', ...MOD })
    expect(handler).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    // An app key nobody registered right now still never reaches the
    // native menu (⌘W would close the desktop window behind the dialog).
    expect(press(document.body, { key: 'w', ...MOD }).defaultPrevented).toBe(true)
    // Keys that are not app shortcuts stay with the page (copy, typing).
    expect(press(document.body, { key: 'c', ...MOD }).defaultPrevented).toBe(false)
  })

  it('lets switchers replace an overlay, closing what cannot stay under it', () => {
    const palette = mock(() => {})
    const newSession = mock(() => {})
    registerShortcut({ key: 'K', mod: true }, palette, () => ({ switcher: true }))
    registerShortcut({ key: 'N', mod: true }, newSession)
    const closed: string[] = []
    pushLayer({ kind: 'overlay', close: () => closed.push('settings') })
    pushLayer({ kind: 'overlay', close: () => closed.push('lightbox'), closeOnSwitch: true })
    press(document.body, { key: 'n', ...MOD })
    expect(newSession).not.toHaveBeenCalled()
    press(document.body, { key: 'k', ...MOD })
    expect(palette).toHaveBeenCalledTimes(1)
    // Settings is swapped by its own store; the lightbox has to be closed.
    expect(closed).toEqual(['lightbox'])
  })

  it('keeps switchers out while a dialog is open or an overlay refuses', () => {
    const palette = mock(() => {})
    registerShortcut({ key: 'K', mod: true }, palette, () => ({ switcher: true }))
    let dirty = true
    const settings = pushLayer({ kind: 'overlay', close: () => {}, allowSwitch: () => !dirty })
    expect(press(document.body, { key: 'k', ...MOD }).defaultPrevented).toBe(true)
    expect(palette).not.toHaveBeenCalled()
    dirty = false
    pushLayer({ kind: 'dialog', close: () => {} })
    press(document.body, { key: 'k', ...MOD })
    expect(palette).not.toHaveBeenCalled()
    removeLayer(settings)
  })

  it('does not block app shortcuts under a transient layer', () => {
    const handler = mock(() => {})
    registerShortcut({ key: 'B', mod: true }, handler)
    pushLayer({ kind: 'transient', close: () => {} })
    press(document.body, { key: 'b', ...MOD })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('runs layer-owned keys only while that layer is on top', () => {
    const next = mock(() => {})
    const lightbox = pushLayer({ kind: 'overlay', close: () => {} })
    registerShortcut({ key: 'ArrowRight' }, next, () => ({ layer: lightbox }))
    press(document.body, { key: 'ArrowRight' })
    expect(next).toHaveBeenCalledTimes(1)
    pushLayer({ kind: 'dialog', close: () => {} })
    press(document.body, { key: 'ArrowRight' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(topLayer()?.kind).toBe('dialog')
  })

  it('runs region keys only when focus is inside the region', () => {
    const minimize = mock(() => {})
    const composer = document.body.appendChild(document.createElement('div'))
    const field = composer.appendChild(document.createElement('textarea'))
    const outside = document.body.appendChild(document.createElement('button'))
    registerShortcut({ key: 'Escape' }, minimize, () => ({ within: () => composer }))
    press(outside, { key: 'Escape' })
    expect(minimize).not.toHaveBeenCalled()
    press(field, { key: 'Escape' })
    expect(minimize).toHaveBeenCalledTimes(1)
  })

  it('keeps region keys inside the blocking layer working', () => {
    const save = mock(() => {})
    const settingsRoot = document.body.appendChild(document.createElement('div'))
    const page = settingsRoot.appendChild(document.createElement('section'))
    const input = page.appendChild(document.createElement('input'))
    registerShortcut({ key: 'S', mod: true }, save, () => ({ within: () => page }))
    pushLayer({ kind: 'overlay', close: () => {}, element: () => settingsRoot })
    press(input, { key: 's', ...MOD })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps bare keys out of text fields unless asked', () => {
    const bare = mock(() => {})
    const chord = mock(() => {})
    const allowed = mock(() => {})
    registerShortcut({ key: '0' }, bare)
    registerShortcut({ key: 'B', mod: true }, chord)
    registerShortcut({ key: 'Enter', alt: true }, allowed, () => ({ allowInEditable: true }))
    const input = document.body.appendChild(document.createElement('input'))
    press(input, { key: '0' })
    press(input, { key: 'b', ...MOD })
    press(input, { key: 'Enter', altKey: true })
    expect(bare).not.toHaveBeenCalled()
    expect(chord).toHaveBeenCalledTimes(1)
    expect(allowed).toHaveBeenCalledTimes(1)
  })

  it('handles the synthetic key a desktop menu command sends', () => {
    const handler = mock(() => {})
    registerShortcut({ key: 'P', mod: true }, handler)
    dispatchAppShortcut(APP_SHORTCUTS.quickOpen, getPlatform().os)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
