/**
 * /telemetry — kept for deep links (``?days=30&traceId=…&session=…``) and
 * restored routes. Telemetry is an overlay now: open it with the requested
 * view and hand the URL back to the workspace.
 */
import { useEffect } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { OPENAGENTD_APP_ICON } from '@/lib/brand-assets'
import { isTelemetryRange, openTelemetry } from '@/stores/useTelemetryStore'

export function TelemetryPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { days?: unknown; traceId?: unknown; session?: unknown }
  const days = isTelemetryRange(search.days) ? search.days : undefined
  const traceId = typeof search.traceId === 'string' && search.traceId !== '' ? search.traceId : undefined
  const session = typeof search.session === 'string' && search.session !== '' ? search.session : undefined

  useEffect(() => {
    openTelemetry({ days, traceId, session })
    void navigate({ to: '/', replace: true })
  }, [days, traceId, session, navigate])

  return (
    <main className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <img src={OPENAGENTD_APP_ICON} width={88} height={88} alt="" aria-hidden="true" className="rounded-2xl" />
    </main>
  )
}
