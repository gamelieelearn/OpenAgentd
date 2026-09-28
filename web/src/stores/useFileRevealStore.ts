/**
 * A request for the file viewer to show a line or a range, from a clicked
 * ``path:line`` or ``path:start-end`` reference. The viewer that shows the
 * file consumes it, so a later, unrelated open of the same file does not
 * jump again.
 */
import { create } from 'zustand'

interface FileRevealRequest {
  path: string
  line: number
  /** Last line of a range, after ``line``. */
  endLine?: number
  /** Distinguishes two clicks on the same reference. */
  key: number
}

interface FileRevealStore {
  request: FileRevealRequest | null
  reveal: (path: string, line: number, endLine?: number) => void
  /** Drop the request if it is still ``key``. */
  consume: (key: number) => void
}

// Module-level so a key is never reused after its request was consumed.
let lastKey = 0

export const useFileRevealStore = create<FileRevealStore>()((set) => ({
  request: null,
  reveal: (path, line, endLine) => set({ request: { path, line, endLine, key: ++lastKey } }),
  consume: (key) => set((state) => (state.request?.key === key ? { request: null } : state)),
}))
