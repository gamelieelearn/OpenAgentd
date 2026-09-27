import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTranscriptStore } from '@/stores/useTranscriptStore'
import type { ContentBlock, PendingQuestion } from '@/api/types'

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1' })
  useTranscriptStore.setState({ readerMode: true })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [], pendingQuestion: null })
  useTranscriptStore.setState({ readerMode: false })
})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'Why does login fail?' },
  { id: 'h1', type: 'thinking', content: 'Considering the session cookie' },
  { id: 't1', type: 'text', content: 'Let me look at the handler.' },
  { id: 'x1', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"auth.ts"}', toolDone: true, toolResult: 'ok', toolCallId: 'c1' },
  { id: 't2', type: 'text', content: 'The cookie expires too early.' },
  { id: 'r1', type: 'user', content: 'explorer report', extra: { from_agent: 'explorer' } },
  { id: 't3', type: 'text', content: 'Noted the report.' },
  { id: 'u2', type: 'user', content: 'Fix it' },
  { id: 'x2', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"auth.ts"}', toolDone: true, toolResult: 'ok', toolCallId: 'c2' },
]

describe('AgentView — reader mode', () => {
  it('shows only the prompts the user wrote and each final answer', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByText('Why does login fail?')).toBeTruthy()
    expect(screen.getByText('The cookie expires too early.')).toBeTruthy()
    expect(screen.queryByText('Let me look at the handler.')).toBeNull()
    expect(screen.queryByText(/Considering the session cookie/)).toBeNull()
    expect(screen.queryByText('explorer report')).toBeNull()
    expect(screen.queryByText(/auth\.ts/)).toBeNull()
  })

  it('says when a finished turn wrote no answer', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByText('No written answer')).toBeTruthy()
  })

  it('passes over a turn that did no work, such as a compaction', () => {
    const blocks: ContentBlock[] = [
      { id: 'u1', type: 'user', content: 'Why does login fail?' },
      { id: 't1', type: 'text', content: 'The cookie expires too early.' },
      { id: 'u2', type: 'user', content: '/compact' },
      { id: 'k1', type: 'compaction', content: 'Summary of the work so far', extra: { state: 'compacted' } },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    expect(screen.queryByText('No written answer')).toBeNull()
  })

  it('keeps a question waiting on the user in view', () => {
    const question: PendingQuestion = {
      id: 'q-1',
      sessionId: 'session-1',
      toolCallId: 'ask-1',
      questions: [{
        question: 'Which cookie lifetime?',
        header: 'Lifetime',
        multiple: false,
        custom: false,
        options: [
          { label: '1 hour', description: null, recommended: true },
          { label: '1 day', description: null, recommended: false },
        ],
      }],
    }
    useAgentStore.setState({ pendingQuestion: question })
    const blocks: ContentBlock[] = [
      { id: 'u1', type: 'user', content: 'Fix login' },
      { id: 'x1', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"auth.ts"}', toolDone: true, toolResult: 'ok', toolCallId: 'c1' },
      { id: 'x2', type: 'tool', content: '', toolName: 'ask_user', toolArgs: '{}', toolDone: true, toolResult: 'Waiting for the user to answer.', toolCallId: 'ask-1' },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} isTurnOpen />)

    expect(screen.getByText('Which cookie lifetime?')).toBeTruthy()
    expect(screen.queryByText(/auth\.ts/)).toBeNull()
    expect(screen.queryByText('Working…')).toBeNull()
  })

  it('says an open turn is still working until an answer arrives', () => {
    const blocks: ContentBlock[] = [
      { id: 'u1', type: 'user', content: 'Fix login' },
      { id: 'x1', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"auth.ts"}', toolDone: false, toolCallId: 'c1' },
    ]

    render(<AgentView blocks={[]} currentBlocks={blocks} isWorking />)

    expect(screen.getByText('Working…')).toBeTruthy()
    expect(screen.queryByText('No written answer')).toBeNull()
  })

  it('says it is on, and switches back to the full transcript', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))
    expect(useTranscriptStore.getState().readerMode).toBe(false)
    expect(screen.getByText('Let me look at the handler.')).toBeTruthy()
  })

  it('finds only what reader mode shows', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} findOpen findQuery="the" />)

    // "the handler" is hidden; "the report" belongs to an agent report's turn, still shown.
    expect(screen.getByText('1/2')).toBeTruthy()
  })
})
