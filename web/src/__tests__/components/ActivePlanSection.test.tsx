import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActivePlanSection } from '@/components/ActivePlanSection'
import type { SessionPlan } from '@/api/types'

const PLAN: SessionPlan = { content: '## Summary\nShip the plan file.', updated_at: new Date(Date.now() - 5 * 60_000).toISOString() }

const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
const revoke = mock(() => {})

beforeAll(() => {
  URL.createObjectURL = mock(() => 'blob:plan') as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL
})
afterAll(() => {
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})
afterEach(cleanup)

describe('ActivePlanSection', () => {
  it('shows when the plan last changed', () => {
    render(<ActivePlanSection plan={PLAN} onClear={() => {}} />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('5m')).toBeTruthy()
  })

  it('opens the plan as a document and releases it on close', () => {
    render(<ActivePlanSection plan={PLAN} onClear={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'View plan' }))
    expect(screen.getByRole('dialog', { name: 'File preview: plan.md' })).toBeTruthy()
    expect(screen.getByText(/Ship the plan file\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.queryByRole('dialog', { name: 'File preview: plan.md' })).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:plan')
  })

  it('clears the plan', () => {
    const onClear = mock(() => {})
    render(<ActivePlanSection plan={PLAN} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear plan' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('opens the Plan tab instead of a document when it can', () => {
    const onOpen = mock(() => {})
    render(<ActivePlanSection plan={PLAN} onClear={() => {}} onOpen={onOpen} />)
    expect(screen.queryByRole('button', { name: 'View plan' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the revision, and Approved only while the approved revision is current', () => {
    const view = render(<ActivePlanSection plan={{ ...PLAN, revision: 3, approved_revision: 3 }} onClear={() => {}} />)
    expect(screen.getByText('rev 3')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    view.unmount()

    render(<ActivePlanSection plan={{ ...PLAN, revision: 4, approved_revision: 3 }} onClear={() => {}} />)
    expect(screen.getByText('rev 4')).toBeTruthy()
    expect(screen.queryByText('Approved')).toBeNull()
  })
})
