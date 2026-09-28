/**
 * Whether the chat transcript follows its live end, for the jump chip on the
 * floating composer, and how to move it, for the chip and for the composer's
 * ``↑``/``↓`` prompt recall. The transcript publishes; the composer uses it.
 */
import { create } from 'zustand'

interface TranscriptFollowState {
  /** ``null`` while following; otherwise blocks that arrived since the reader scrolled away. */
  unseen: number | null
  /** Scrolls the transcript back to its live end; set while one is mounted. */
  jumpToLatest: (() => void) | null
  /** Brings a loaded prompt into view by block id; set while a transcript is mounted. */
  showPrompt: ((id: string) => void) | null
}

export const useTranscriptFollowStore = create<TranscriptFollowState>(() => ({
  unseen: null,
  jumpToLatest: null,
  showPrompt: null,
}))
