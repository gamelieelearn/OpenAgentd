/**
 * Messages held until the running turn ends ("Queue until done").
 *
 * Client-side on purpose: the backend's queue hands a queued message to the
 * agent before its next model call, which steers the turn rather than
 * following it. A held message is sent as a turn of its own once the current
 * one has ended (see ``AgentChatView/heldMessages.ts``). It lives outside the
 * agent store so a session switch, which resets that store, does not drop it;
 * a reload does, since ``File`` objects cannot be persisted.
 */
import { create } from 'zustand'
import type { MessageAttachment } from '@/api/types'

export interface HeldMessage {
  id: string
  sessionId: string
  content: string
  files?: File[]
  /** Display metadata for ``files``. */
  attachments?: MessageAttachment[]
  mentions?: string[]
}

interface HeldMessagesState {
  messages: HeldMessage[]
  hold: (message: Omit<HeldMessage, 'id' | 'attachments'>) => void
  /** Removes and returns the oldest message held for ``sessionId``. */
  takeNext: (sessionId: string) => HeldMessage | null
  /** Removes and returns every message held for ``sessionId``, oldest first. */
  takeAll: (sessionId: string) => HeldMessage[]
  take: (id: string) => HeldMessage | null
}

let nextId = 0

export const useHeldMessagesStore = create<HeldMessagesState>((set, get) => {
  const takeWhere = (match: (message: HeldMessage) => boolean, limit = Infinity) => {
    const taken: HeldMessage[] = []
    const kept = get().messages.filter((message) => {
      if (taken.length >= limit || !match(message)) return true
      taken.push(message)
      return false
    })
    if (taken.length > 0) set({ messages: kept })
    return taken
  }

  return {
    messages: [],
    hold: (message) => {
      nextId += 1
      const attachments = message.files?.map((file): MessageAttachment => ({
        original_name: file.name,
        media_type: file.type,
        category: file.type.startsWith('image/') ? 'image' : 'document',
      }))
      set((state) => ({
        messages: [
          ...state.messages,
          { ...message, id: `held-${nextId}`, ...(attachments?.length ? { attachments } : {}) },
        ],
      }))
    },
    takeNext: (sessionId) => takeWhere((m) => m.sessionId === sessionId, 1)[0] ?? null,
    takeAll: (sessionId) => takeWhere((m) => m.sessionId === sessionId),
    take: (id) => takeWhere((m) => m.id === id, 1)[0] ?? null,
  }
})
