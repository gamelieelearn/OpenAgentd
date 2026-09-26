import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { listTraces, getTraceDetail, type ObservabilityFilters } from '@/api/client'
import { queryKeys } from './keys'

/** Paginated list of ``agent_run`` spans (one row per turn). */
export function useTracesQuery(days: number, limit = 50, offset = 0) {
  return useQuery({
    queryKey: queryKeys.observability.traces(days, limit, offset),
    queryFn: () => listTraces(days, limit, offset),
    // Traces are append-only — moderate staleness is fine.
    staleTime: 30_000,
  })
}

/** Paginated list of ``agent_run`` spans, newest first. */
export function useInfiniteTracesQuery(
  days: number,
  limit = 25,
  filters: ObservabilityFilters & { errorsOnly?: boolean } = {},
) {
  const normalized = {
    workspace: filters.workspace ?? null,
    model: filters.model ?? null,
    session: filters.session ?? null,
  }
  const errorsOnly = filters.errorsOnly ?? false
  return useInfiniteQuery({
    queryKey: queryKeys.observability.infiniteTraces(days, limit, normalized, errorsOnly),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listTraces(days, limit, pageParam, { ...normalized, errorsOnly }),
    getNextPageParam: (lastPage) => (
      lastPage.has_next ? lastPage.offset + lastPage.limit : undefined
    ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

/**
 * Full span tree for one trace.  ``null`` when the trace has expired.
 * ``days`` must cover the trace's age, so callers pass the list's window.
 */
export function useTraceDetailQuery(traceId: string | null, days = 30) {
  return useQuery({
    queryKey: queryKeys.observability.trace(traceId ?? ''),
    queryFn: () => getTraceDetail(traceId!, days),
    // Only fetch when a trace is selected.
    enabled: traceId !== null && traceId !== '',
    // Historical data — never goes stale inside a session.
    staleTime: Infinity,
  })
}
