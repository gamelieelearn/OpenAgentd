import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { clearSessionPlan, getSessionPlan } from '@/api/client'
import { queryKeys } from './keys'

/** The session plan; refetched when the ``plan`` tool changes it and when a
 *  plan review closes. Edits made outside the app show on the next refetch. */
export function useSessionPlanQuery(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.plan(sessionId ?? ''),
    queryFn: () => getSessionPlan(sessionId as string),
    enabled: !!sessionId,
    staleTime: 5_000,
  })
}

export function useClearSessionPlanMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => clearSessionPlan(sessionId),
    onSuccess: (_data, sessionId) => {
      client.invalidateQueries({ queryKey: queryKeys.plan(sessionId) })
    },
  })
}
