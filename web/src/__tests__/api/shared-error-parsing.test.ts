import { describe, it, expect } from "bun:test"
import { parseDetailOrThrow, ApiValidationError } from "@/api/client/_shared"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

async function captureError(res: Response, label = "POST /agent/chat"): Promise<ApiValidationError> {
  try {
    await parseDetailOrThrow(res, label)
  } catch (err) {
    return err as ApiValidationError
  }
  throw new Error("parseDetailOrThrow did not throw")
}

describe("parseDetailOrThrow", () => {
  it("preserves the HTTP status on the thrown error", async () => {
    const err = await captureError(jsonResponse(409, { detail: "already exists" }))
    expect(err).toBeInstanceOf(ApiValidationError)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(409)
    expect(err.message).toBe("already exists")
  })

  it("joins Pydantic validation detail entries", async () => {
    const err = await captureError(
      jsonResponse(422, { detail: [{ msg: "field required" }, { msg: "too long" }] }),
    )
    expect(err.status).toBe(422)
    expect(err.message).toBe("field required; too long")
  })

  // ── Degenerate payloads must still produce a usable message ───────────────
  // These all used to yield "" or "; ", which surfaces in the UI as an empty
  // error toast. Every branch falls back to the labelled status instead.

  it("falls back to the label for an empty detail array", async () => {
    const err = await captureError(jsonResponse(422, { detail: [] }))
    expect(err.message).toBe("POST /agent/chat failed: 422")
  })

  it("falls back to the label when detail entries have no msg", async () => {
    const err = await captureError(jsonResponse(422, { detail: [{ loc: ["a"] }, { loc: ["b"] }] }))
    expect(err.message).toBe("POST /agent/chat failed: 422")
  })

  it("skips falsey msg entries rather than emitting empty separators", async () => {
    const err = await captureError(
      jsonResponse(422, { detail: [{ msg: "" }, { msg: "real problem" }, {}] }),
    )
    expect(err.message).toBe("real problem")
  })

  it("falls back to the label for an empty detail string", async () => {
    const err = await captureError(jsonResponse(500, { detail: "" }))
    expect(err.message).toBe("POST /agent/chat failed: 500")
  })

  it("falls back to the label for an object detail", async () => {
    // Some routes return a structured detail, e.g. observability's
    // {reason, trace_id} on a 404.
    const err = await captureError(jsonResponse(404, { detail: { reason: "gone" } }), "getTrace")
    expect(err.status).toBe(404)
    expect(err.message).toBe("getTrace failed: 404")
  })

  it("keeps a structured detail on the error for callers to inspect", async () => {
    const err = await captureError(jsonResponse(404, { detail: { reason: "trace_not_found", trace_id: "t1" } }), "getTrace")
    expect(err.detail).toEqual({ reason: "trace_not_found", trace_id: "t1" })
  })

  it("uses the message of a structured detail when it has one", async () => {
    const err = await captureError(jsonResponse(503, { detail: { status: "degraded", message: "Database unavailable" } }), "ready")
    expect(err.message).toBe("Database unavailable")
  })

  it("falls back to the label for a non-JSON body", async () => {
    const err = await captureError(new Response("<html>502</html>", { status: 502 }), "getThing")
    expect(err.status).toBe(502)
    expect(err.message).toBe("getThing failed: 502")
  })
})
