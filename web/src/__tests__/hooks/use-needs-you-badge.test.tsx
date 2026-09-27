import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const setBadgeCount = mock(async (..._args: unknown[]) => {})
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri: true, os: 'macos' }) }))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setBadgeCount }) }))

const { useNeedsYouBadge } = await import('@/hooks/use-needs-you-badge')
const { queryKeys } = await import('@/queries')

afterEach(() => {
  cleanup()
  setBadgeCount.mockClear()
})

function activePage(ids: string[]) {
  return {
    pages: [{
      data: ids.map((id) => ({ id, title: id, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', running: true, needs_input: true })),
      next_cursor: null,
      has_more: false,
    }],
    pageParams: [null],
  }
}

describe('useNeedsYouBadge', () => {
  it('mirrors the sessions waiting on the user onto the app badge', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    client.setQueryData(queryKeys.session.sessions.active(), activePage(['a', 'b']))
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useNeedsYouBadge(), { wrapper })
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBe(2)
    expect(setBadgeCount.mock.calls.at(-1)).toEqual([2])

    act(() => {
      client.setQueryData(queryKeys.session.sessions.active(), activePage([]))
    })
    await waitFor(() => expect(result.current).toBe(0))
    expect(setBadgeCount.mock.calls.at(-1)).toEqual([undefined])
  })
})
