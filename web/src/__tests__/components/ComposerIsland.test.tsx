/**
 * ComposerIsland — the collapsed composer as a status line for the lead agent.
 *
 * It reads the turn from the store, so the tests seed the store and drive it
 * through the states a turn goes through: at rest, running, waiting on a
 * question, and just finished with files changed.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const answerQuestion = mock(async (..._args: unknown[]) => ({ status: 'answered', resumed: true }))
const dismissQuestion = mock(async (..._args: unknown[]) => ({ status: 'dismissed', resumed: false }))
const agentStream = mock(() => {})
mock.module('@/api/client', () => ({ answerQuestion, dismissQuestion, agentStream }))

import { ComposerIsland } from '@/components/ComposerIsland'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import type { AgentStream } from '@/stores/useAgentStore/types'
import type { ContentBlock, PendingQuestion } from '@/api/types'

const QUESTION: PendingQuestion = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  // Several may be picked, so the island leaves it to the card.
  questions: [{ question: 'Which ones?', header: 'Pick', multiple: true, custom: false, options: [{ label: 'A', recommended: false }] }],
}

const CHOICE: PendingQuestion = {
  id: 'q-2',
  sessionId: 's-1',
  toolCallId: 'call-2',
  questions: [{
    question: 'Which package manager should the project use?',
    header: 'Package manager',
    multiple: false,
    custom: false,
    options: [
      { label: 'pnpm', recommended: true },
      { label: 'bun', recommended: false },
    ],
  }],
}

const user = (content: string): ContentBlock => ({ id: `u-${content}`, type: 'user', content })
const read = (path: string, done = false): ContentBlock => ({
  id: `read-${path}`,
  type: 'tool',
  content: '',
  toolName: 'read',
  toolArgs: JSON.stringify({ path }),
  toolDone: done,
})
const patch = (path: string): ContentBlock => ({
  id: `patch-${path}`,
  type: 'tool',
  content: '',
  toolName: 'patch',
  toolArgs: JSON.stringify({ patch_text: `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n+c\n*** End Patch` }),
  toolDone: true,
  toolResult: '[Succeeded]',
})

function seedLead(stream: Partial<AgentStream>, state: Record<string, unknown> = {}) {
  const status = stream.status ?? 'idle'
  useAgentStore.setState({
    sessionId: 's-1',
    leadName: 'lead',
    agentStreams: { lead: { ...createDefaultAgentStream(), ...stream } },
    isAgentWorking: status === 'working' || status === 'waiting_input',
    pendingQuestion: null,
    ...state,
  })
}

beforeEach(() => {
  answerQuestion.mockClear()
  answerQuestion.mockImplementation(async () => ({ status: 'answered', resumed: true }))
  seedLead({})
  useAgentStore.setState({ resolvedQuestions: {} })
  useHeldMessagesStore.setState({ messages: [] })
})
afterEach(cleanup)

describe('ComposerIsland — at rest', () => {
  it('shows only the mode', () => {
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    const island = screen.getByRole('button', { name: 'Expand input bar' })
    expect(island.textContent).toBe('Code')
  })

  it('describes its state to screen readers', () => {
    render(<ComposerIsland mode="plan" onExpand={() => {}} />)

    const island = screen.getByRole('button', { name: 'Expand input bar' })
    const description = document.getElementById(island.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe('Plan mode')
  })

  it('marks Plan mode so the pill can take its tint', () => {
    const { container } = render(<ComposerIsland mode="plan" onExpand={() => {}} />)

    expect(container.querySelector('[data-island="rest"][data-mode="plan"]')).not.toBeNull()
  })

  it('opens the composer', () => {
    const onExpand = mock(() => {})
    render(<ComposerIsland mode="code" onExpand={onExpand} />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand input bar' }))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})

describe('ComposerIsland — running', () => {
  it('shows the current step and how long the turn has run', () => {
    seedLead({ status: 'working', currentBlocks: [user('go'), read('src/main.tsx')], _turnStartedAt: Date.now() - 65_000 })
    render(<ComposerIsland mode="code" onExpand={() => {}} onStop={() => {}} />)

    const island = screen.getByRole('button', { name: 'Expand input bar' })
    expect(island.textContent).toContain('Reading main.tsx')
    expect(island.textContent).toContain('1:05')
  })

  it('follows the turn as it moves on', () => {
    seedLead({ status: 'working', currentBlocks: [user('go'), read('a.ts')] })
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    act(() => {
      useAgentStore.setState((state) => {
        state.agentStreams.lead.currentBlocks = [user('go'), read('a.ts', true), { id: 't', type: 'text', content: 'Done' }]
      })
    })
    expect(screen.getByRole('button', { name: 'Expand input bar' }).textContent).toContain('Writing')
  })

  it('stops the turn', () => {
    seedLead({ status: 'working', currentBlocks: [user('go')] })
    const onStop = mock(() => {})
    const onExpand = mock(() => {})
    render(<ComposerIsland mode="code" onExpand={onExpand} onStop={onStop} />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('counts the messages waiting for this turn to end', () => {
    seedLead({ status: 'working', currentBlocks: [user('go')] })
    useHeldMessagesStore.getState().hold({ sessionId: 's-1', content: 'then this' })
    useHeldMessagesStore.getState().hold({ sessionId: 's-1', content: 'and this' })
    useHeldMessagesStore.getState().hold({ sessionId: 's-2', content: 'elsewhere' })
    render(<ComposerIsland mode="code" onExpand={() => {}} onStop={() => {}} />)

    const island = screen.getByRole('button', { name: 'Expand input bar' })
    expect(island.textContent).toContain('2 queued')
    const description = document.getElementById(island.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe('Working: Starting · 2 messages queued until done')
  })
})

describe('ComposerIsland — waiting on a question', () => {
  it('says the agent is waiting for an answer', () => {
    seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: QUESTION })
    render(<ComposerIsland mode="code" onExpand={() => {}} onStop={() => {}} />)

    expect(screen.getByRole('button', { name: 'Expand input bar' }).textContent).toContain('Waiting for your answer')
    expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull()
  })

  it('ignores a question another session is waiting on', () => {
    seedLead({ status: 'working', currentBlocks: [user('go')] }, { pendingQuestion: { ...QUESTION, sessionId: 's-2' } })
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    expect(screen.getByRole('button', { name: 'Expand input bar' }).textContent).not.toContain('Waiting for your answer')
  })

  it('jumps to the open question card', () => {
    seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: QUESTION })
    const card = document.createElement('div')
    card.setAttribute('data-question-waiting', '')
    const scrollIntoView = mock(() => {})
    card.scrollIntoView = scrollIntoView
    document.body.appendChild(card)
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Go to the question' }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    card.remove()
  })
})

describe('ComposerIsland — answering from the island', () => {
  it('offers the choices of a single-choice question, recommended one marked', () => {
    seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: CHOICE })
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    expect(screen.getByRole('button', { name: 'Expand input bar' }).textContent).toContain('Package manager')
    expect(screen.getByRole('button', { name: 'Answer pnpm (recommended)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Answer bun' })).toBeTruthy()
  })

  it('sends the picked choice as the answer', async () => {
    seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: CHOICE })
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Answer bun' }))

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0]).toEqual(['s-1', 'q-2', [['bun']]])
    await waitFor(() => expect(useAgentStore.getState().pendingQuestion).toBeNull())
    expect(useAgentStore.getState().resolvedQuestions['call-2']?.answers).toEqual([['bun']])
  })

  it('says why an answer did not send and keeps the choices', async () => {
    answerQuestion.mockImplementation(async () => { throw new Error('Network unreachable') })
    seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: CHOICE })
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Answer bun' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Network unreachable'))
    expect(screen.getByRole('button', { name: 'Answer bun' })).toBeTruthy()
  })

  it('still leads to the card when the answer may be typed', () => {
    const custom = { ...CHOICE, questions: [{ ...CHOICE.questions[0], custom: true }] }
    seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: custom })
    render(<ComposerIsland mode="code" onExpand={() => {}} />)

    expect(screen.getByRole('button', { name: 'Answer bun' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Go to the question' }).textContent).toBe('Other…')
  })

  it('leaves questions the island cannot hold to the card', () => {
    const many = { ...CHOICE, questions: [CHOICE.questions[0], { ...CHOICE.questions[0], header: 'Second' }] }
    const multi = { ...CHOICE, questions: [{ ...CHOICE.questions[0], multiple: true }] }
    const wide = {
      ...CHOICE,
      questions: [{ ...CHOICE.questions[0], options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, recommended: false })) }],
    }
    for (const question of [many, multi, wide]) {
      seedLead({ status: 'waiting_input', currentBlocks: [user('go')] }, { pendingQuestion: question })
      render(<ComposerIsland mode="code" onExpand={() => {}} />)
      expect(screen.queryByRole('button', { name: /^Answer / })).toBeNull()
      expect(screen.getByRole('button', { name: 'Go to the question' }).textContent).toBe('Answer')
      cleanup()
    }
  })
})

describe('ComposerIsland — turn just finished', () => {
  it('summarises the files the turn changed and opens them for review', () => {
    seedLead({ status: 'working', currentBlocks: [user('go'), patch('src/a.ts')] })
    const onReviewChanges = mock(() => {})
    render(<ComposerIsland mode="code" onExpand={() => {}} onReviewChanges={onReviewChanges} />)

    act(() => {
      useAgentStore.setState((state) => {
        state.isAgentWorking = false
        state.agentStreams.lead.status = 'idle'
        state.agentStreams.lead.blocks = [user('go'), patch('src/a.ts'), patch('src/b.ts')]
        state.agentStreams.lead.currentBlocks = []
      })
    })

    const island = screen.getByRole('button', { name: 'Expand input bar' })
    expect(island.textContent).toContain('2 files changed')
    expect(island.textContent).toContain('+4')
    expect(island.textContent).toContain('−2')
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(onReviewChanges).toHaveBeenCalledTimes(1)
  })

  it('rests when the turn changed nothing', () => {
    seedLead({ status: 'working', currentBlocks: [user('go')] })
    const { container } = render(<ComposerIsland mode="code" onExpand={() => {}} />)

    act(() => {
      useAgentStore.setState((state) => {
        state.isAgentWorking = false
        state.agentStreams.lead.status = 'idle'
        state.agentStreams.lead.blocks = [user('go'), read('a.ts', true)]
        state.agentStreams.lead.currentBlocks = []
      })
    })
    expect(container.querySelector('[data-island="rest"]')).not.toBeNull()
  })

  it('does not read a session switch as a finished turn', () => {
    seedLead({ status: 'working', currentBlocks: [user('go')] })
    const { container } = render(<ComposerIsland mode="code" onExpand={() => {}} />)

    act(() => {
      seedLead({ blocks: [user('elsewhere'), patch('x.ts')] }, { sessionId: 's-2' })
    })
    expect(container.querySelector('[data-island="rest"]')).not.toBeNull()
  })

  it('clears the summary when the next turn starts', () => {
    seedLead({ status: 'working', currentBlocks: [user('go')] })
    const { container } = render(<ComposerIsland mode="code" onExpand={() => {}} />)
    act(() => {
      useAgentStore.setState((state) => {
        state.isAgentWorking = false
        state.agentStreams.lead.status = 'idle'
        state.agentStreams.lead.blocks = [user('go'), patch('a.ts')]
        state.agentStreams.lead.currentBlocks = []
      })
    })
    expect(container.querySelector('[data-island="done"]')).not.toBeNull()

    act(() => {
      useAgentStore.setState((state) => {
        state.isAgentWorking = true
        state.agentStreams.lead.status = 'working'
        state.agentStreams.lead.currentBlocks = [user('next')]
      })
    })
    expect(container.querySelector('[data-island="running"]')).not.toBeNull()
  })
})
