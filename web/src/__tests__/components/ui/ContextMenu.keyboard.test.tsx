import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { ContextMenu } from '@/components/ui/context-menu'

afterEach(cleanup)

function Harness({ onRename = () => {} }: { onRename?: () => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button type="button" onContextMenu={(e) => { e.preventDefault(); setAt({ x: 40, y: 60 }) }}>
        Terminal 1
      </button>
      {at && (
        <ContextMenu at={at} label="Actions for Terminal 1" onDismiss={() => setAt(null)}>
          <button type="button" role="menuitem" onClick={() => { setAt(null); onRename() }}>Rename</button>
          <button type="button" role="menuitem" disabled>Duplicate</button>
          <button type="button" role="menuitem">Close</button>
        </ContextMenu>
      )}
    </>
  )
}

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Terminal 1' })
  trigger.focus()
  fireEvent.contextMenu(trigger)
  return trigger
}

describe('ContextMenu', () => {
  it('focuses the first item and moves with arrows, Home and End, skipping disabled items', () => {
    render(<Harness />)
    openMenu()
    const menu = screen.getByRole('menu', { name: 'Actions for Terminal 1' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Close' }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Close' }))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Close' }))
  })

  it('closes on Escape and returns focus to the trigger', () => {
    render(<Harness />)
    const trigger = openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Tab and on a backdrop click', () => {
    render(<Harness />)
    openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()

    openMenu()
    fireEvent.click(screen.getByRole('menu').parentElement!)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lets an item act and close the menu', () => {
    const onRename = mock(() => {})
    render(<Harness onRename={onRename} />)
    openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    fireEvent.click(document.activeElement!)
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
