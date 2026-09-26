/**
 * useTelemetryStore — what the telemetry overlay shows.
 *
 * Visibility lives in ``useUIStore.telemetryOpen`` alongside the other
 * mutually exclusive overlays; this store keeps the view: time range,
 * filters, "failed only", and the open trace. Only the range persists —
 * filters point at workspaces and models that may be gone next launch, and
 * an open trace should not reappear after a reload.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useUIStore } from './useUIStore'

export const TELEMETRY_RANGES = [1, 7, 30, 90] as const
export type TelemetryRange = (typeof TELEMETRY_RANGES)[number]

export interface OpenTelemetryOptions {
  days?: TelemetryRange
  workspace?: string | null
  model?: string | null
  session?: string | null
  traceId?: string | null
}

interface TelemetryState {
  days: TelemetryRange
  workspace: string | null
  model: string | null
  /** Session id: narrows every card to one session. */
  session: string | null
  errorsOnly: boolean
  traceId: string | null
  setDays: (days: TelemetryRange) => void
  setWorkspace: (workspace: string | null) => void
  setModel: (model: string | null) => void
  setSession: (session: string | null) => void
  setErrorsOnly: (value: boolean) => void
  openTrace: (traceId: string) => void
  closeTrace: () => void
  clearFilters: () => void
}

export function isTelemetryRange(value: unknown): value is TelemetryRange {
  return TELEMETRY_RANGES.includes(value as TelemetryRange)
}

export const useTelemetryStore = create<TelemetryState>()(
  persist(
    (set) => ({
      days: 7,
      workspace: null,
      model: null,
      session: null,
      errorsOnly: false,
      traceId: null,
      setDays: (days) => set({ days }),
      setWorkspace: (workspace) => set({ workspace }),
      setModel: (model) => set({ model }),
      setSession: (session) => set({ session }),
      setErrorsOnly: (errorsOnly) => set({ errorsOnly }),
      openTrace: (traceId) => set({ traceId }),
      closeTrace: () => set({ traceId: null }),
      clearFilters: () => set({ workspace: null, model: null, session: null, errorsOnly: false }),
    }),
    {
      name: 'oa.telemetry.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ days: state.days }),
      merge: (persisted, current) => {
        const days = (persisted as { days?: unknown } | undefined)?.days
        return isTelemetryRange(days) ? { ...current, days } : current
      },
    },
  ),
)

/**
 * Open the telemetry overlay, optionally jumping to a range, filter, or trace
 * (deep links from ``/telemetry?traceId=…``, the palette, and the status bar).
 * Filters carry over from the last visit; an open trace does not, so entry
 * points without a ``traceId`` land on the overview.
 */
export function openTelemetry(options: OpenTelemetryOptions = {}): void {
  const patch: Partial<TelemetryState> = { traceId: options.traceId ?? null }
  if (options.days !== undefined) patch.days = options.days
  if (options.workspace !== undefined) patch.workspace = options.workspace
  if (options.model !== undefined) patch.model = options.model
  if (options.session !== undefined) patch.session = options.session
  useTelemetryStore.setState(patch)
  useUIStore.getState().openTelemetry()
}
