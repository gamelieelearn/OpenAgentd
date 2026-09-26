import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { usePanelResize } from '@/hooks/use-panel-resize'

afterEach(cleanup)

function Harness({ edge, width, onCommit, onReset }: {
  edge: 'left' | 'right'
  width: number
  onCommit: (width: number) => void
  onReset: () => void
}) {
  const resize = usePanelResize({ width, min: 200, max: 400, edge, onCommit, onReset, label: 'Resize panel' })
  return <div {...resize.handleProps} />
}

describe('usePanelResize', () => {
  it('exposes an accessible, keyboard-reachable separator', () => {
    render(<Harness edge="right" width={260} onCommit={() => {}} onReset={() => {}} />)
    const handle = screen.getByRole('separator', { name: 'Resize panel' })
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
    expect(handle.getAttribute('aria-valuemin')).toBe('200')
    expect(handle.getAttribute('aria-valuemax')).toBe('400')
  })

  it('grows toward the handle edge with arrow keys and clamps with Home/End', () => {
    const commits: number[] = []
    const onCommit = (width: number) => { commits.push(width) }
    const { rerender } = render(<Harness edge="right" width={260} onCommit={onCommit} onReset={() => {}} />)
    const handle = screen.getByRole('separator')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(handle, { key: 'End' })
    expect(commits).toEqual([276, 200, 400])

    commits.length = 0
    rerender(<Harness edge="left" width={260} onCommit={onCommit} onReset={() => {}} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' })
    expect(commits).toEqual([276, 200])
  })

  it('resets on Enter and on double-click', () => {
    const onReset = mock(() => {})
    render(<Harness edge="left" width={260} onCommit={() => {}} onReset={onReset} />)
    const handle = screen.getByRole('separator')
    fireEvent.keyDown(handle, { key: 'Enter' })
    fireEvent.doubleClick(handle)
    expect(onReset).toHaveBeenCalledTimes(2)
  })
})
