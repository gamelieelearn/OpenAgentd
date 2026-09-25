/**
 * Shared internals for the API client domain modules: the validation
 * error type and the response-detail parser used across every group.
 */

export class ApiValidationError extends Error {
  status: number
  /** The response's raw `detail` (string, validation array, or object). */
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
    this.name = 'ApiValidationError'
  }
}

export async function parseDetailOrThrow(res: Response, label: string): Promise<never> {
  // Always keep a usable message: an empty `detail` string, an empty detail
  // array, or entries missing `msg` must not degrade the thrown error to `""`
  // or `"; "` — fall back to the labelled status instead. An object `detail`
  // (e.g. `{reason, trace_id}`) uses its `message` when present, else the
  // label; the raw value stays on `error.detail` either way.
  const fallback = `${label} failed: ${res.status}`
  let detail = fallback
  let raw: unknown
  try {
    const body = await res.json()
    raw = body?.detail
    if (typeof body?.detail === 'string') {
      detail = body.detail || fallback
    } else if (Array.isArray(body?.detail)) {
      const joined = body.detail
        .map((e: { msg?: string }) => e?.msg)
        .filter(Boolean)
        .join('; ')
      detail = joined || fallback
    } else if (body?.detail && typeof body.detail === 'object' && typeof body.detail.message === 'string') {
      detail = body.detail.message || fallback
    }
  } catch {
    // Non-JSON body — keep the fallback.
  }
  throw new ApiValidationError(res.status, detail, raw)
}

// ── /agents ──────────────────────────────────────────────────────────────────
