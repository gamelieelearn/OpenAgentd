import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SessionModeToggle } from '@/components/SessionModeToggle'

afterEach(cleanup)

describe('SessionModeToggle', () => {
  test('is one chip naming the mode, and a click switches to the other', () => {
    const onChange = mock(() => {})

    render(<SessionModeToggle mode="code" onChange={onChange} />)

    const chip = screen.getByRole('button', { name: 'Code mode' })
    expect(chip.textContent).toBe('Code')
    expect(chip.getAttribute('title')).toBe('Switch to Plan mode (Tab)')
    expect(screen.queryByRole('button', { name: 'Plan mode' })).toBeNull()
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith('plan')
  })

  test('switches back from Plan', () => {
    const onChange = mock(() => {})

    render(<SessionModeToggle mode="plan" onChange={onChange} />)

    const chip = screen.getByRole('button', { name: 'Plan mode' })
    expect(chip.dataset.mode).toBe('plan')
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith('code')
  })

  test('marks a queued switch as not yet in force', () => {
    // The backend defers a mid-turn switch instead of stopping the turn, so
    // the chip has to show the pick without claiming it is already active.
    render(<SessionModeToggle mode="plan" pending onChange={() => {}} />)

    const queued = screen.getByRole('button', { name: 'Plan mode (applies after the current turn)' })
    expect(queued.getAttribute('title')).toBe('Applies when the current turn finishes')
  })

  test('cannot switch while disabled', () => {
    const onChange = mock(() => {})
    render(<SessionModeToggle mode="code" disabled onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Code mode' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
