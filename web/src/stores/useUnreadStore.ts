/**
 * Sessions whose latest turn ended while nobody was looking at them.
 *
 * Client-only: the server keeps no read state. Every window hears the same
 * ``session_turn_completed`` events and marks sessions it is not showing; a
 * window showing one (while visible) clears it. Persisted so a reload keeps
 * the marks, and shared through the ``storage`` event so reading a session in
 * one window clears it in the others. Sessions that finish while the app is
 * closed are not marked.
 *
 * ``lastSeen`` is the newest confirmed block each session showed on screen,
 * which places the transcript's "New" line on the next visit. Block ids are
 * stable across reloads, so no clock is involved.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useDocumentVisible } from '@/hooks/use-document-visible'

export const UNREAD_STORAGE_KEY = 'oa.unread-sessions.v1'
const MAX_UNREAD = 200
const MAX_LAST_SEEN = 200

interface UnreadState {
  /** Oldest first; capped so deleted sessions cannot pile up forever. */
  ids: string[]
  /** Session id → last block id seen; insertion order is recency. */
  lastSeen: Record<string, string>
  markUnread: (sessionId: string) => void
  markRead: (sessionId: string) => void
  markSeen: (sessionId: string, blockId: string) => void
}

export const useUnreadStore = create<UnreadState>()(
  persist(
    (set, get) => ({
      ids: [],
      lastSeen: {},
      markUnread: (sessionId) => {
        if (get().ids.includes(sessionId)) return
        set({ ids: [...get().ids, sessionId].slice(-MAX_UNREAD) })
      },
      markRead: (sessionId) => {
        if (!get().ids.includes(sessionId)) return
        set({ ids: get().ids.filter((id) => id !== sessionId) })
      },
      markSeen: (sessionId, blockId) => {
        if (get().lastSeen[sessionId] === blockId) return
        const { [sessionId]: _previous, ...rest } = get().lastSeen
        const entries = [...Object.entries(rest), [sessionId, blockId] as const].slice(-MAX_LAST_SEEN)
        set({ lastSeen: Object.fromEntries(entries) })
      },
    }),
    {
      name: UNREAD_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ ids: state.ids, lastSeen: state.lastSeen }),
      merge: (persisted, current) => {
        const saved = persisted as { ids?: unknown; lastSeen?: unknown } | undefined
        const ids = Array.isArray(saved?.ids)
          ? saved.ids.filter((id): id is string => typeof id === 'string')
          : current.ids
        const lastSeen = saved?.lastSeen && typeof saved.lastSeen === 'object'
          ? Object.fromEntries(Object.entries(saved.lastSeen).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : current.lastSeen
        return { ...current, ids, lastSeen }
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
