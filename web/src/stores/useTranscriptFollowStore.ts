/**
 * Whether the chat transcript follows its live end, for the jump chip on the
 * floating composer. The transcript publishes; the composer draws the chip.
 */
import { create } from 'zustand'

interface TranscriptFollowState {
  /** ``null`` while following; otherwise blocks that arrived since the reader scrolled away. */
  unseen: number | null
  /** Scrolls the transcript back to its live end; set while one is mounted. */
  jumpToLatest: (() => void) | null
}

export const useTranscriptFollowStore = create<TranscriptFollowState>(() => ({
  unseen: null,
  jumpToLatest: null,
}))
