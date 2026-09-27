import { describe, expect, it } from 'bun:test'
import type { SessionResponse } from '@/api/types'
import { activeSessionCounts, needsYouSessions } from '@/lib/active-sessions'

function session(overrides: Partial<SessionResponse>): SessionResponse {
  return { id: 's', title: null, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', ...overrides }
}

describe('needsYouSessions', () => {
  it('keeps only top-level sessions waiting on the user', () => {
    const rows = [
      session({ id: 'ask', running: true, needs_input: true }),
      // An older server ignores ``active`` and sends a normal page.
      session({ id: 'busy', running: true }),
      session({ id: 'idle' }),
      session({ id: 'child', needs_input: true, parent_session_id: 'lead' }),
    ]

    const kept = needsYouSessions({ pages: [{ data: rows, next_cursor: null, has_more: false }], pageParams: [null] })

    expect(kept.map((s) => s.id)).toEqual(['ask'])
  })

  it('is empty before the list loads', () => {
    expect(needsYouSessions(undefined)).toEqual([])
  })
})

describe('activeSessionCounts', () => {
  it('counts top-level sessions still working apart from those waiting on the user', () => {
    const rows = [
      session({ id: 'ask', running: true, needs_input: true }),
      session({ id: 'busy', running: true }),
      session({ id: 'busy-too', running: true }),
      session({ id: 'idle' }),
      session({ id: 'child', running: true, parent_session_id: 'lead' }),
      session({ id: 'no-workspace', running: true, workspace: null }),
    ]

    const counts = activeSessionCounts({ pages: [{ data: rows, next_cursor: null, has_more: false }], pageParams: [null] })

    expect(counts).toEqual({ running: 2, needsYou: 1 })
  })

  it('is zero before the list loads', () => {
    expect(activeSessionCounts(undefined)).toEqual({ running: 0, needsYou: 0 })
  })
})
