import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TokenMeter } from '@/components/ui/token-meter'

afterEach(cleanup)

const METER_NAME = 'Input: 1,500 of 250,000 before auto-compact (1%) · Output: 200 · Cache: 2.00%'

describe('TokenMeter', () => {
  it('shows detail on hover', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} cachedPercent={2} />)

    const trigger = screen.getByRole('button', { name: METER_NAME })

    await user.hover(trigger)

    expect(screen.getByRole('tooltip')).toBeTruthy()
    expect(screen.getByText('input')).toBeTruthy()
    // The threshold is named for what happens there, not "trigger".
    expect(screen.getByText('auto-compact at')).toBeTruthy()
    expect(screen.queryByText('trigger')).toBeNull()
    expect(screen.getByText('1,500')).toBeTruthy()
    expect(screen.getByText('200')).toBeTruthy()
    expect(screen.getByText('2.00%')).toBeTruthy()
  })

  it('shows sub-cent session costs to four decimal places', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} sessionCostUsd={0.0042} />)

    await user.hover(screen.getByRole('button'))

    // Every other row is this agent's; the cost covers the whole team, so the
    // label has to say which scope it belongs to.
    expect(screen.getByText('session cost')).toBeTruthy()
    expect(screen.queryByText('cost')).toBeNull()
    expect(screen.getByText('$0.0042')).toBeTruthy()
  })

  it('rounds session costs of a cent or more to cents', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} sessionCostUsd={12.3456} />)

    await user.hover(screen.getByRole('button'))

    expect(screen.getByText('$12.35')).toBeTruthy()
  })

  it('closes after hover when the pointer leaves', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} cachedPercent={2} />)

    const trigger = screen.getByRole('button', { name: METER_NAME })

    await user.hover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.unhover(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('stays open after click until toggled off', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} cachedPercent={2} />)

    const trigger = screen.getByRole('button', { name: METER_NAME })

    await user.click(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.unhover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
