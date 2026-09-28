/**
 * Whether the chat transcript follows its live end, for the jump chip on the
 * floating composer, and how to move it, for the chip and for the composer's
 * ``↑``/``↓`` prompt recall. The transcript publishes; the composer and the
 * mobile chat actions use it.
 */
import { create } from 'zustand'

interface TranscriptFollowState {
  /** ``null`` while following; otherwise blocks that arrived since the reader scrolled away. */
  unseen: number | null
  /** Scrolls the transcript back to its live end; set while one is mounted. */
  jumpToLatest: (() => void) | null
  /** Brings a loaded prompt into view by block id; set while a transcript is mounted. */
  showPrompt: ((id: string) => void) | null
  /** Steps to the previous (-1) or next (1) prompt, like ⌥⌘↑/↓; set while a transcript is mounted. */
  jumpToPrompt: ((direction: -1 | 1) => void) | null
}

export const useTranscriptFollowStore = create<TranscriptFollowState>(() => ({
  unseen: null,
  jumpToLatest: null,
  showPrompt: null,
  jumpToPrompt: null,
}))
