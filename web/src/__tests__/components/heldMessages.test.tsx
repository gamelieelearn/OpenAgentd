/**
 * "Queue until done": a held message is sent as a turn of its own once the
 * running turn has ended, and goes back to the composer whenever it should
 * not be sent after all.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import { stopTurn, useReleaseHeldMessages } from '@/components/AgentChatView/heldMessages'
import type { InputComposerHandle } from '@/components/InputComposer'

const INITIAL_AGENT_STATE = useAgentStore.getState()

function fakeComposer() {
  const appended: Array<{ text: string; paragraph?: boolean }> = []
  const added: File[] = []
  const handle: InputComposerHandle = {
    focus: () => {},
    setValue: () => {},
    insertText: () => {},
    setFiles: () => {},
    appendValue: (text, options) => { appended.push({ text, paragraph: options?.paragraph }) },
    addFiles: (files) => { added.push(...files) },
    restoreLastSubmission: () => {},
  }
  return { ref: { current: handle }, appended, added }
}

/** Stands in for the store's send, which marks the agent working before it awaits. */
function sendThatStartsATurn(delivered = true) {
  return mock(async (..._args: unknown[]) => {
    useAgentStore.setState({ isAgentWorking: true })
    return delivered
  })
}

const held = () => useHeldMessagesStore.getState().messages.map((m) => m.content)

beforeEach(() => {
  useHeldMessagesStore.setState({ messages: [] })
  useAgentStore.setState({
    sessionId: 's1',
    isAgentWorking: true,
    _syncedThrough: '2026-01-01T00:00:00Z',
    leadName: 'lead',
    agentStreams: {},
  })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState(INITIAL_AGENT_STATE, true)
})

describe('useReleaseHeldMessages', () => {
  it('sends the oldest held message once the turn has ended', () => {
    const sendMessage = sendThatStartsATurn()
    const photo = new File(['x'], 'photo.png', { type: 'image/png' })
    useAgentStore.setState({ sendMessage, sessionModel: 'gpt-5' })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first', files: [photo], mentions: ['src/a.ts'] })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'second' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    expect(sendMessage).not.toHaveBeenCalled()

    act(() => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]).toEqual([
      'first',
      [photo],
      { workspace: '/repo', model: 'gpt-5', thinkingLevel: null, fastMode: false, mentions: ['src/a.ts'] },
    ])
    expect(held()).toEqual(['second'])
  })

  it('waits for the session history before trusting an idle agent', () => {
    // A session switch resets the working flag before the server has said
    // whether the turn is still running.
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false, _syncedThrough: null })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    expect(sendMessage).not.toHaveBeenCalled()

    act(() => { useAgentStore.setState({ _syncedThrough: '2026-01-01T00:00:00Z' }) })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('leaves messages held for another session alone', () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false })
    useHeldMessagesStore.getState().hold({ sessionId: 's2', content: 'elsewhere' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(held()).toEqual(['elsewhere'])
  })

  it('returns a message that could not be sent, and the ones behind it, to the composer', async () => {
    const sendMessage = mock(async (..._args: unknown[]) => false)
    useAgentStore.setState({ sendMessage })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first' })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'second' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(composer.appended).toEqual([{ text: 'first\n\nsecond', paragraph: true }])
    expect(held()).toEqual([])
  })

  it('returns held messages to the composer instead of following a failed turn', () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({
      sendMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
    })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'then do this' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    act(() => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.appended).toEqual([{ text: 'then do this', paragraph: true }])
  })
})

describe('stopTurn', () => {
  it('hands held messages back to the composer before stopping the turn', async () => {
    const order: string[] = []
    const stopAgent = mock(async () => { order.push('stop') })
    useAgentStore.setState({ stopAgent })
    const notes = new File(['y'], 'notes.md', { type: 'text/markdown' })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first', files: [notes] })
    useHeldMessagesStore.getState().hold({ sessionId: 's2', content: 'elsewhere' })
    const composer = fakeComposer()
    composer.ref.current.appendValue = (text) => { order.push(`restore ${text}`) }

    await stopTurn(composer.ref.current)

    expect(order).toEqual(['restore first', 'stop'])
    expect(composer.added).toEqual([notes])
    expect(held()).toEqual(['elsewhere'])
  })
})
