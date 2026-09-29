import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSessionPlan } from '@/api/client'
import { queryKeys } from './keys'

interface UpdateSessionPlanVars {
  sessionId: string
  content: string
  /** The revision the editor opened; the server answers 409 when it moved on. */
  baseRevision: number
}

/** Save the user's edit to the session plan from the Plan tab. */
export function useUpdateSessionPlanMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, content, baseRevision }: UpdateSessionPlanVars) => updateSessionPlan(sessionId, content, baseRevision),
    onSuccess: (data, { sessionId }) => {
      client.setQueryData(queryKeys.plan(sessionId), data)
      client.invalidateQueries({ queryKey: queryKeys.plan(sessionId) })
    },
  })
}
