import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitForElementToBeRemoved } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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

/**
 * Floating panels are placed after they mount and measure themselves. A
 * transition duration on the panel (Tailwind's ``duration-*`` sets one, and
 * ``transition-property`` defaults to ``all``) slides it from its first spot
 * into place, so only the entrance animation may carry a duration.
 */
describe('floating panels — entrance', () => {
  const TRANSITION_DURATION = /(^|\s)duration-/

  function placeTrigger(trigger: HTMLElement, top: number) {
    trigger.getBoundingClientRect = () => ({
      top, bottom: top + 28, left: 500, right: 528, width: 28, height: 28, x: 500, y: top, toJSON: () => ({}),
    })
  }

  it('grows a dropdown out of the corner at its trigger instead of sliding it into place', async () => {
    render(
      <>
        <Dropdown trigger="Up" aria-label="Up" align="end">
          <DropdownItem>One</DropdownItem>
        </Dropdown>
        <Dropdown trigger="Down" aria-label="Down">
          <DropdownItem>Two</DropdownItem>
        </Dropdown>
      </>,
    )
    // At the window's bottom edge, so this one opens upward.
    placeTrigger(screen.getByRole('button', { name: 'Up' }), window.innerHeight - 28)
    placeTrigger(screen.getByRole('button', { name: 'Down' }), 100)

    await userEvent.click(screen.getByRole('button', { name: 'Up' }))
    const up = screen.getByRole('menu')
    expect(up.className).not.toMatch(TRANSITION_DURATION)
    expect(up.className).toMatch(/(^|\s)origin-bottom-right(\s|$)/)

    await userEvent.click(screen.getByRole('button', { name: 'Down' }))
    const down = screen.getAllByRole('menu').find((menu) => menu.textContent === 'Two')!
    expect(down.className).toMatch(/(^|\s)origin-top-left(\s|$)/)
  })

  it('fades a popover in without sliding it into place', async () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Details</PopoverContent>
      </Popover>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open' }))

    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    expect(content.className).not.toMatch(TRANSITION_DURATION)
  })
})

/**
 * DESIGN.md → Motion: dropdowns are ``base`` (240ms) with the ``ease-out``
 * entrance curve. The exit is ``fast`` (150ms) so a picked item's panel is
 * out of the way sooner, and the panel stays mounted until the exit ends.
 */
describe('floating panels — motion tokens', () => {
  const has = (el: Element, token: string) => el.className.split(/\s+/).includes(token)

  it('opens a dropdown at the base duration and closes it at the fast one', async () => {
    render(
      <Dropdown trigger="More" aria-label="More">
        <DropdownItem>One</DropdownItem>
      </Dropdown>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    const panel = screen.getByRole('menu')
    expect(has(panel, 'animation-duration-(--motion-base)')).toBe(true)
    expect(has(panel, 'ease-(--ease-out)')).toBe(true)

    await userEvent.keyboard('{Escape}')
    const closing = screen.getByRole('menu')
    expect(has(closing, 'animate-out')).toBe(true)
    expect(has(closing, 'animation-duration-(--motion-fast)')).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(screen.queryByRole('menu')).not.toBeNull()
    await waitForElementToBeRemoved(() => screen.queryByRole('menu'))
  })

  it('opens a popover at the base duration and closes it at the fast one', async () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Details</PopoverContent>
      </Popover>,
    )
    const content = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]')

    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(has(content()!, 'animation-duration-(--motion-base)')).toBe(true)
    expect(has(content()!, 'ease-(--ease-out)')).toBe(true)

    await userEvent.keyboard('{Escape}')
    expect(has(content()!, 'animation-duration-(--motion-fast)')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(content()).not.toBeNull()
    await waitForElementToBeRemoved(content)
  })
})
