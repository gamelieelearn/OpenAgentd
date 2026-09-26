/**
 * The Telemetry view chunk, shared by the overlay's ``lazy()`` and the
 * hover/focus preload on its triggers, so either path requests it once.
 *
 * Preloading waits for intent rather than idle time: in the packaged shells
 * the assets are local, so a launch-time warm-up would only spend CPU and
 * memory on a view most sessions never open (see ``optimistic-preload.ts``).
 */
export const loadTelemetryView = () => import('./TelemetryView')

export function preloadTelemetryView(): void {
  void loadTelemetryView().catch(() => {
    // A failed preload is not an error; opening the view retries.
  })
}
