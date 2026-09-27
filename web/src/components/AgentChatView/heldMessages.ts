/**
 * "Queue until done" — the lifecycle of a held message (see
 * ``useHeldMessagesStore``): sent as a turn of its own once the running turn
 * ends, or handed back to the composer whenever sending it would no longer be
 * what the user asked for.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'
import { useHeldMessagesStore, type HeldMessage } from '@/stores/useHeldMessagesStore'
import type { InputComposerHandle } from '../InputComposer'

/** Send with the session's current model settings, as the composer does. */
export function sendFromComposer(workspace: string, content: string, files?: File[], mentions?: string[]) {
  const current = useAgentStore.getState()
  return current.sendMessage(content, files, {
    workspace,
    model: current.sessionModel || null,
    thinkingLevel: current.sessionThinkingLevel || null,
    fastMode: current.sessionFastMode,
    mentions,
  })
}

/** Put held messages back in the composer, after anything it already holds. */
export function returnToComposer(composer: InputComposerHandle | null, held: HeldMessage[]) {
  if (!composer || held.length === 0) return
  composer.appendValue(held.map((message) => message.content).join('\n\n'), { paragraph: true })
  const files = held.flatMap((message) => message.files ?? [])
  if (files.length > 0) composer.addFiles(files)
  composer.focus()
}

/**
 * Stop the running turn. Stopping also calls off what was lined up behind it,
 * so held messages return to the composer rather than starting a turn the
 * moment this one ends.
 */
export function stopTurn(composer: InputComposerHandle | null): Promise<void> {
  const { sessionId, stopAgent } = useAgentStore.getState()
  if (sessionId) returnToComposer(composer, useHeldMessagesStore.getState().takeAll(sessionId))
  return stopAgent()
}

/** Sends held messages one turn at a time as the session goes idle. */
export function useReleaseHeldMessages({ workspace, sessionId, composerRef }: {
  workspace: string | null
  sessionId: string | null
  composerRef: RefObject<InputComposerHandle | null>
}) {
  const heldCount = useHeldMessagesStore((s) => (
    sessionId ? s.messages.filter((message) => message.sessionId === sessionId).length : 0
  ))
  // A session switch clears the working flag before the server has said
  // whether that session's turn is still running; its loaded history is what
  // makes an idle flag trustworthy.
  const idle = useAgentStore((s) => !s.isAgentWorking && s._syncedThrough !== null)
  const turnFailed = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?.status === 'error' : false))
  const releasingRef = useRef(false)

  useEffect(() => {
    if (!workspace || !sessionId || !idle || heldCount === 0 || releasingRef.current) return
    const store = useHeldMessagesStore.getState()
    // A follow-up was written for a turn that succeeded.
    if (turnFailed) {
      returnToComposer(composerRef.current, store.takeAll(sessionId))
      return
    }
    const next = store.takeNext(sessionId)
    if (!next) return
    releasingRef.current = true
    void sendFromComposer(workspace, next.content, next.files, next.mentions)
      .then((delivered) => {
        if (!delivered) {
          returnToComposer(composerRef.current, [next, ...useHeldMessagesStore.getState().takeAll(sessionId)])
        }
      })
      .finally(() => { releasingRef.current = false })
  }, [workspace, sessionId, idle, heldCount, turnFailed, composerRef])
}
