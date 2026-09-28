import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { clearSessionPlan, getSessionPlan } from '@/api/client'
import { queryKeys } from './keys'

/** The saved Plan-mode plan; refetched after each Plan-mode turn. */
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
