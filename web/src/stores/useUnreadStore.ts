/**
 * Sessions whose latest turn ended while nobody was looking at them.
 *
 * Client-only: the server keeps no read state. Every window hears the same
 * ``session_turn_completed`` events and marks sessions it is not showing; a
 * window showing one (while visible) clears it. Persisted so a reload keeps
 * the marks, and shared through the ``storage`` event so reading a session in
 * one window clears it in the others. Sessions that finish while the app is
 * closed are not marked.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useDocumentVisible } from '@/hooks/use-document-visible'

export const UNREAD_STORAGE_KEY = 'oa.unread-sessions.v1'
const MAX_UNREAD = 200

interface UnreadState {
  /** Oldest first; capped so deleted sessions cannot pile up forever. */
  ids: string[]
  markUnread: (sessionId: string) => void
  markRead: (sessionId: string) => void
}

export const useUnreadStore = create<UnreadState>()(
  persist(
    (set, get) => ({
      ids: [],
      markUnread: (sessionId) => {
        if (get().ids.includes(sessionId)) return
        set({ ids: [...get().ids, sessionId].slice(-MAX_UNREAD) })
      },
      markRead: (sessionId) => {
        if (!get().ids.includes(sessionId)) return
        set({ ids: get().ids.filter((id) => id !== sessionId) })
      },
    }),
    {
      name: UNREAD_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ ids: state.ids }),
      merge: (persisted, current) => {
        const ids = (persisted as { ids?: unknown } | undefined)?.ids
        return Array.isArray(ids)
          ? { ...current, ids: ids.filter((id): id is string => typeof id === 'string') }
          : current
      },
    },
  ),
)

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === UNREAD_STORAGE_KEY) void useUnreadStore.persist.rehydrate()
  })
}

/** Clears the unread mark of the session on screen, now and whenever it returns. */
export function useMarkSessionRead(sessionId: string | null | undefined): void {
  const unread = useUnreadStore((state) => (sessionId ? state.ids.includes(sessionId) : false))
  const visible = useDocumentVisible()

  useEffect(() => {
    if (sessionId && unread && visible) useUnreadStore.getState().markRead(sessionId)
  }, [sessionId, unread, visible])
}
