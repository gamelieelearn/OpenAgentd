import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useActiveSessionsQuery', () => {
  it('asks the server for running and waiting sessions in one page', async () => {
    setApiBaseUrl('')
    const fetchMock = mock(async (_input: unknown) => new Response(JSON.stringify({
      data: [{ id: 's1', title: 'T', agent_name: 'lead', created_at: null, updated_at: null, needs_input: true }],
      next_cursor: null,
      has_more: false,
    })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useActiveSessionsQuery(), { wrapper })

    await waitFor(() => expect(result.current.data?.pages[0].data[0].id).toBe('s1'))
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(url.pathname).toBe('/api/agent/sessions')
    expect(url.searchParams.get('active')).toBe('true')
  })
})
