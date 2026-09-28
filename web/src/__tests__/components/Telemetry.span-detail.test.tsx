import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

afterEach(cleanup)

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SpanDetailPanel } from '@/components/Telemetry/SpanDetailPanel'
import type { SpanDetail } from '@/api/client'

function span(attributes: Record<string, unknown>): SpanDetail {
  return {
    span_id: 'span-1234567890abcdef',
    parent_span_id: null,
    trace_id: 'trace-1',
    name: 'chat gpt-test',
    kind: 'INTERNAL',
    start_ms: 1_700_000_000_000,
    end_ms: 1_700_000_001_000,
    duration_ms: 1000,
    status: 'OK',
    attributes,
  }
}

describe('SpanDetailPanel', () => {
  it('renders estimated model-call cost as a dedicated card', () => {
    render(
      <SpanDetailPanel
        span={span({
          'gen_ai.usage.input_tokens': 1000,
          'gen_ai.usage.output_tokens': 100,
          'gen_ai.usage.estimated_cost_usd': 0.00135,
        })}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('Estimated cost')).toBeTruthy()
    expect(screen.getByText('$0.00135')).toBeTruthy()
    expect(
      screen.getByText('Based on registry pricing and provider usage tokens.'),
    ).toBeTruthy()
  })

  it('omits the estimated cost card when cost is absent', () => {
    render(
      <SpanDetailPanel
        span={span({ 'gen_ai.usage.input_tokens': 1000 })}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText('Estimated cost')).toBeNull()
  })

  it('shows how fast a model call started and streamed', () => {
    render(
      <SpanDetailPanel
        span={span({
          'gen_ai.response.time_to_first_chunk': 0.8234,
          'openagentd.response.output_tokens_per_second': 61.7,
        })}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('First token')).toBeTruthy()
    expect(screen.getByText('823 ms')).toBeTruthy()
    expect(screen.getByText('Output speed')).toBeTruthy()
    expect(screen.getByText('62 tok/s')).toBeTruthy()
  })

  it('omits speed rows for spans without them', () => {
    render(<SpanDetailPanel span={span({ 'gen_ai.usage.input_tokens': 1000 })} onClose={() => {}} />)
    expect(screen.queryByText('First token')).toBeNull()
    expect(screen.queryByText('Output speed')).toBeNull()
  })

  it('lists only attributes the span set', () => {
    render(
      <SpanDetailPanel
        span={span({ 'gen_ai.request.model': 'gpt-test', 'gen_ai.response.model': null })}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('gen_ai.request.model')).toBeTruthy()
    expect(screen.queryByText('gen_ai.response.model')).toBeNull()
  })
})
