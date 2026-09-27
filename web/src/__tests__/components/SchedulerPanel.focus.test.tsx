/**
 * Opening the scheduler on one task (a click in the sidebar's Scheduled list):
 * both the dock view and the overlay land on that task's detail, once.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import { SchedulerDockView } from '@/components/SchedulerPanel/SchedulerDockView'
import { useUIStore } from '@/stores/useUIStore'
import type { ScheduledTaskResponse } from '@/api/types'

function task(id: string, name: string): ScheduledTaskResponse {
  return { id, slug: id, name, workspace: '/repo/app', schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null, timezone: 'UTC', prompt: 'Do the thing', session_id: null, enabled: true, status: 'pending', run_count: 0, max_runs: null, last_run_at: null, last_error: null, next_fire_at: null, created_at: '2026-05-25T00:00:00Z', updated_at: '2026-05-25T00:00:00Z' }
}

function withTasks(ui: React.ReactElement) {
  const tasks = [task('t1', 'Nightly build'), task('t2', 'Weekly report')]
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ tasks }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  useUIStore.setState({ scheduledTaskFocus: null })
})

describe('scheduler task focus', () => {
  it('opens the dock view on the focused task', async () => {
    useUIStore.getState().focusScheduledTask('t2')

    withTasks(<SchedulerDockView contextWorkspace={null} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument())
    expect(screen.getByText('Weekly report')).toBeInTheDocument()
    expect(screen.queryByText('Nightly build')).not.toBeInTheDocument()
    expect(useUIStore.getState().scheduledTaskFocus).toBeNull()
  })

  it('opens the overlay on the focused task', async () => {
    useUIStore.getState().focusScheduledTask('t1')

    withTasks(<SchedulerPanel open onClose={() => {}} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument())
    expect(useUIStore.getState().scheduledTaskFocus).toBeNull()
  })
})
