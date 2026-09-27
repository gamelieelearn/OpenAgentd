import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { Dropdown, DropdownItem } from '@/components/ui/dropdown'

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

afterEach(() => {
  cleanup()
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
})

describe('Dropdown — alignment', () => {
  it('lines the panel up with the end of the trigger when aligned to the end', async () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    render(
      <Dropdown trigger="More" aria-label="More" align="end">
        <DropdownItem>One</DropdownItem>
      </Dropdown>,
    )
    const trigger = screen.getByRole('button', { name: 'More' })
    trigger.getBoundingClientRect = () => ({
      top: 100, bottom: 128, left: 500, right: 528, width: 28, height: 28, x: 500, y: 100, toJSON: () => ({}),
    })

    await userEvent.click(trigger)

    expect(screen.getByRole('menu').style.left).toBe('328px')
  })
})
