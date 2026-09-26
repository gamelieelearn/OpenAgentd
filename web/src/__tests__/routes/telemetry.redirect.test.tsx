/**
 * /telemetry is a deep-link shim: it opens the overlay with the requested
 * range and trace, then replaces the URL with the coding workspace.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

const navigate = mock(() => Promise.resolve())
let search: Record<string, unknown> = {}
mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}))

import { TelemetryPage } from '@/routes/telemetry'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'

afterEach(() => {
  cleanup()
  navigate.mockClear()
  search = {}
  useUIStore.setState({ telemetryOpen: false })
  useTelemetryStore.setState({ days: 7, traceId: null, session: null })
  localStorage.removeItem('oa.telemetry.v1')
})

describe('/telemetry', () => {
  it('opens the overlay on the linked range, trace, and session, then goes to /coding', () => {
    search = { days: 30, traceId: 'trace-1', session: 'sess-1' }
    render(<TelemetryPage />)

    expect(useUIStore.getState().telemetryOpen).toBe(true)
    expect(useTelemetryStore.getState()).toMatchObject({ days: 30, traceId: 'trace-1', session: 'sess-1' })
    expect(navigate).toHaveBeenCalledWith({ to: '/coding', replace: true })
  })

  it('ignores ranges the overlay does not offer', () => {
    search = { days: 14 }
    render(<TelemetryPage />)

    expect(useTelemetryStore.getState()).toMatchObject({ days: 7, traceId: null })
    expect(useUIStore.getState().telemetryOpen).toBe(true)
  })
})
