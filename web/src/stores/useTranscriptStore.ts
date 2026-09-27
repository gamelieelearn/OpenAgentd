/**
 * useTranscriptStore — how the transcript reads: density, reading size, and
 * reader mode.
 *
 * Density and size persist. Reader mode is session-only: it hides every
 * tool call, and coming back to a transcript missing its work after a
 * reload would look like data loss.
 */
import type { CSSProperties } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const TRANSCRIPT_STORAGE_KEY = 'oa.transcript.v1'

export type TranscriptDensity = 'compact' | 'comfortable' | 'relaxed'

export const TRANSCRIPT_DENSITIES: readonly { value: TranscriptDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'relaxed', label: 'Relaxed' },
]

/** Reading sizes in px; the floor is DESIGN.md's 11px, with room to spare. */
export const TRANSCRIPT_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const
export const DEFAULT_TRANSCRIPT_FONT_SIZE = 14
const DEFAULT_DENSITY: TranscriptDensity = 'comfortable'

const RHYTHM: Record<TranscriptDensity, { turnGap: string; blockGap: string; lineHeight: string }> = {
  compact: { turnGap: '0.5rem', blockGap: '0.25rem', lineHeight: '1.6' },
  comfortable: { turnGap: '0.75rem', blockGap: '0.5rem', lineHeight: '1.75' },
  relaxed: { turnGap: '1.25rem', blockGap: '0.75rem', lineHeight: '1.85' },
}

/** CSS variables for the transcript root; prose and turn spacing read them. */
export function transcriptStyle(density: TranscriptDensity, fontSize: number): CSSProperties {
  const rhythm = RHYTHM[density]
  return {
    '--transcript-font-size': `${fontSize / 16}rem`,
    '--transcript-line-height': rhythm.lineHeight,
    '--transcript-turn-gap': rhythm.turnGap,
    '--transcript-block-gap': rhythm.blockGap,
  } as CSSProperties
}

function isDensity(value: unknown): value is TranscriptDensity {
  return value === 'compact' || value === 'comfortable' || value === 'relaxed'
}

function isFontSize(value: unknown): value is number {
  return typeof value === 'number' && (TRANSCRIPT_FONT_SIZES as readonly number[]).includes(value)
}

interface TranscriptState {
  density: TranscriptDensity
  fontSize: number
  readerMode: boolean
  setDensity: (density: TranscriptDensity) => void
  /** One step along ``TRANSCRIPT_FONT_SIZES``; stops at either end. */
  stepFontSize: (direction: -1 | 1) => void
  resetFontSize: () => void
  toggleReaderMode: () => void
}

export const useTranscriptStore = create<TranscriptState>()(
  persist(
    (set) => ({
      density: DEFAULT_DENSITY,
      fontSize: DEFAULT_TRANSCRIPT_FONT_SIZE,
      readerMode: false,
      setDensity: (density) => set({ density }),
      stepFontSize: (direction) => set((state) => {
        const sizes = TRANSCRIPT_FONT_SIZES as readonly number[]
        const index = sizes.indexOf(state.fontSize)
        const from = index < 0 ? sizes.indexOf(DEFAULT_TRANSCRIPT_FONT_SIZE) : index
        return { fontSize: sizes[Math.max(0, Math.min(sizes.length - 1, from + direction))] }
      }),
      resetFontSize: () => set({ fontSize: DEFAULT_TRANSCRIPT_FONT_SIZE }),
      toggleReaderMode: () => set((state) => ({ readerMode: !state.readerMode })),
    }),
    {
      name: TRANSCRIPT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ density, fontSize }) => ({ density, fontSize }),
      // Hand-edited or older storage must not break the transcript's layout.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Pick<TranscriptState, 'density' | 'fontSize'>>
        return {
          ...current,
          density: isDensity(stored.density) ? stored.density : DEFAULT_DENSITY,
          fontSize: isFontSize(stored.fontSize) ? stored.fontSize : DEFAULT_TRANSCRIPT_FONT_SIZE,
        }
      },
    },
  ),
)
