/**
 * How a composer message reaches the agent while a turn runs, and the
 * lifecycle of one held for "Queue until done" (see ``useHeldMessagesStore``):
 * sent as a turn of its own once the running turn ends, or handed back to the
 * composer whenever sending it would no longer be what the user asked for.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'
import { useHeldMessagesStore, type HeldMessage } from '@/stores/useHeldMessagesStore'
import type { InputComposerHandle, SendDelivery } from '../InputComposer'

/** Send with the session's current model settings, as the composer does. */
function sendFromComposer(workspace: string, content: string, files?: File[], mentions?: string[]) {
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
  const mentions = [...new Set(held.flatMap((message) => message.mentions ?? []))]
  composer.appendValue(held.map((message) => message.content).join('\n\n'), { paragraph: true, ...(mentions.length > 0 ? { mentions } : {}) })
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

/** Send a composer message the way the user chose; an idle agent just starts a turn. */
export async function deliverFromComposer(
  workspace: string,
  composer: InputComposerHandle | null,
  message: { content: string; files?: File[]; mentions?: string[] },
  delivery: SendDelivery = 'steer',
): Promise<void> {
  const { isAgentWorking, sessionId } = useAgentStore.getState()
  if (isAgentWorking && sessionId && delivery === 'after-turn') {
    useHeldMessagesStore.getState().hold({ sessionId, ...message })
    return
  }
  let calledOff: HeldMessage[] = []
  if (isAgentWorking && delivery === 'interrupt') {
    // Stopping calls off held messages as any stop does, but they return to
    // the composer only after this send, so a failed send restores its own
    // draft first (``restoreLastSubmission`` yields to a non-empty composer).
    if (sessionId) calledOff = useHeldMessagesStore.getState().takeAll(sessionId)
    await useAgentStore.getState().stopAgent()
  }
  const delivered = await sendFromComposer(workspace, message.content, message.files, message.mentions)
  // The composer cleared itself on submit; a send that never landed gets its
  // draft and attachments back instead of vanishing behind an error banner.
  if (!delivered) composer?.restoreLastSubmission()
  returnToComposer(composer, calledOff)
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
