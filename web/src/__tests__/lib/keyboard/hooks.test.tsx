import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { getPlatform } from '@/hooks/use-platform'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useKeyLayer, useShortcut } from '@/lib/keyboard/hooks'
import { layerStack } from '@/lib/keyboard/layers'

const MOD = getPlatform().os === 'macos' ? { metaKey: true } : { ctrlKey: true }
const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(event)
  return event
}

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

function Shortcut({ onPress, enabled = true }: { onPress: () => void; enabled?: boolean }) {
  useShortcut({ key: 'J', mod: true }, onPress, { enabled })
  return null
}

function Layer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useKeyLayer(open, { kind: 'dialog', onClose })
  return null
}

describe('keyboard hooks', () => {
  it('registers while mounted, follows the latest handler and enabled flag', () => {
    const first = mock(() => {})
    const second = mock(() => {})
    const { rerender, unmount } = render(<Shortcut onPress={first} />)
    press({ key: 'j', ...MOD })
    rerender(<Shortcut onPress={second} />)
    press({ key: 'j', ...MOD })
    rerender(<Shortcut onPress={second} enabled={false} />)
    press({ key: 'j', ...MOD })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    rerender(<Shortcut onPress={second} />)
    unmount()
    press({ key: 'j', ...MOD })
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('pushes a layer while open and pops it when closed', () => {
    const onClose = mock(() => {})
    const { rerender } = render(<Layer open={false} onClose={onClose} />)
    expect(layerStack()).toHaveLength(0)
    rerender(<Layer open onClose={onClose} />)
    expect(layerStack().map((l) => l.kind)).toEqual(['dialog'])
    act(() => { press({ key: 'Escape' }) })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<Layer open={false} onClose={onClose} />)
    expect(layerStack()).toHaveLength(0)
  })
})
