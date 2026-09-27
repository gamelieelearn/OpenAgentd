/**
 * A request for the file viewer to show one line, from a clicked
 * ``path:line`` reference. The viewer that shows the file consumes it, so a
 * later, unrelated open of the same file does not jump again.
 */
import { create } from 'zustand'

interface FileRevealRequest {
  path: string
  line: number
  /** Distinguishes two clicks on the same reference. */
  key: number
}

interface FileRevealStore {
  request: FileRevealRequest | null
  reveal: (path: string, line: number) => void
  /** Drop the request if it is still ``key``. */
  consume: (key: number) => void
}

// Module-level so a key is never reused after its request was consumed.
let lastKey = 0

export const useFileRevealStore = create<FileRevealStore>()((set) => ({
  request: null,
  reveal: (path, line) => set({ request: { path, line, key: ++lastKey } }),
  consume: (key) => set((state) => (state.request?.key === key ? { request: null } : state)),
}))
