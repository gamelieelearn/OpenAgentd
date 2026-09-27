/**
 * ComposerIsland — the collapsed composer as a status line for the lead.
 *
 * At rest it names the mode. While a turn runs it shows the current step, the
 * elapsed time and how many messages wait for the turn to end, beside Stop;
 * while the lead waits on a question it offers the choices of a single-choice
 * question inline, or leads to the card; and once a turn that changed files
 * ends, it sums them up until the next turn starts or the composer opens.
 *
 * It subscribes to the store itself, so a streaming turn re-renders this line
 * rather than the composer around it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, Loader2, MessageCircleQuestion, Square } from 'lucide-react'

import type { PendingQuestion, QuestionItem, SessionInteractionMode } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import type { AgentStore } from '@/stores/useAgentStore/types'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import { mergeBlocks } from '@/utils/blocks'
import { cn } from '@/lib/utils'
import { useQuestionResolver } from './AskUser/useQuestionResolver'
import type { TurnChangeSummary } from './ToolCall/grouping'
import { currentStep, formatElapsed, lastTurnChanges } from './ComposerIsland.status'

export interface ComposerIslandProps {
  mode: SessionInteractionMode
  onExpand: () => void
  onStop?: () => void
  onReviewChanges?: () => void
}

type IslandKind = 'rest' | 'running' | 'waiting' | 'done'

const leadStream = (state: AgentStore) => (state.leadName ? state.agentStreams[state.leadName] : undefined)

/** More choices than this do not fit on one line; the card takes them. */
const MAX_INLINE_CHOICES = 4

/** The one question the island can answer in place, if that is what is asked. */
function inlineChoice(question: PendingQuestion | null): QuestionItem | null {
  const item = question?.questions.length === 1 ? question.questions[0] : null
  return item && !item.multiple && item.options.length > 0 && item.options.length <= MAX_INLINE_CHOICES ? item : null
}

/** Changes of the turn that just ended here; a session switch is not one. */
function useFinishedTurnChanges(running: boolean, sessionId: string | null): TurnChangeSummary | null {
  const [changes, setChanges] = useState<TurnChangeSummary | null>(null)
  const previous = useRef({ running, sessionId })
  // Layout effect, so the summary replaces the running line in one paint.
  useLayoutEffect(() => {
    const was = previous.current
    previous.current = { running, sessionId }
    if (running || was.sessionId !== sessionId) {
      setChanges(null)
      return
    }
    if (!was.running) return
    const stream = leadStream(useAgentStore.getState())
    const summary = stream ? lastTurnChanges(mergeBlocks(stream.blocks, stream.currentBlocks)) : null
    setChanges(summary && summary.files.length > 0 ? summary : null)
  }, [running, sessionId])
  return changes
}

function useElapsed(startedAt: number | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, startedAt])
  return active && startedAt !== null ? now - startedAt : null
}

function goToQuestion() {
  const card = document.querySelector<HTMLElement>('[data-question-waiting]')
  if (!card) return
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  card.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  card.querySelector<HTMLElement>('input, button, textarea')?.focus({ preventScroll: true })
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

const ACTION =
  'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-(--color-text) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) md:h-7'
const CHOICE =
  'flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs text-(--color-text) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) disabled:cursor-default disabled:opacity-50 md:h-6'

export function ComposerIsland({ mode, onExpand, onStop, onReviewChanges }: ComposerIslandProps) {
  const descriptionId = useId()
  const sessionId = useAgentStore((s) => s.sessionId)
  const running = useAgentStore((s) => s.isAgentWorking)
  const question = useAgentStore((s) => (s.pendingQuestion?.sessionId === s.sessionId ? s.pendingQuestion : null))
  const waiting = question !== null
  const choice = inlineChoice(question)
  const resolver = useQuestionResolver(question)
  const step = useAgentStore((s) => (s.isAgentWorking ? currentStep(leadStream(s)?.currentBlocks ?? []) : null))
  const startedAt = useAgentStore((s) => leadStream(s)?._turnStartedAt ?? null)
  const elapsed = useElapsed(startedAt, running && !waiting)
  const changes = useFinishedTurnChanges(running, sessionId)
  const heldCount = useHeldMessagesStore((s) => s.messages.filter((m) => m.sessionId === sessionId).length)

  const kind: IslandKind = waiting ? 'waiting' : running ? 'running' : changes ? 'done' : 'rest'
  const modeLabel = mode === 'plan' ? 'Plan' : 'Code'

  let body: React.ReactNode
  let description: string
  if (kind === 'waiting') {
    body = (
      <>
        <MessageCircleQuestion size={12} aria-hidden="true" className="shrink-0 text-(--color-info)" />
        {resolver.error ? (
          <span className="min-w-0 max-w-60 truncate text-(--color-error)">{resolver.error}</span>
        ) : (
          <span className="min-w-0 max-w-60 truncate">{choice ? choice.header || choice.question : 'Waiting for your answer'}</span>
        )}
      </>
    )
    description = choice ? `Waiting for your answer: ${choice.question}` : 'Waiting for your answer'
  } else if (kind === 'running') {
    body = (
      <>
        <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin text-(--color-text-muted) motion-reduce:animate-none" />
        <span className="min-w-0 max-w-80 truncate">{step}</span>
        {elapsed !== null && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-muted)">{formatElapsed(elapsed)}</span>
        )}
        {heldCount > 0 && (
          <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 py-0.5 font-mono text-[11px] text-(--color-text-subtle)">
            {heldCount} queued
          </span>
        )}
      </>
    )
    description = heldCount > 0
      ? `Working: ${step} · ${plural(heldCount, 'message')} queued until done`
      : `Working: ${step}`
  } else if (kind === 'done' && changes) {
    const files = plural(changes.files.length, 'file')
    body = (
      <>
        <Check size={12} aria-hidden="true" className="shrink-0 text-(--color-success)" />
        <span className="truncate">{files} changed</span>
        <span className="flex shrink-0 gap-1 font-mono text-[11px] font-semibold">
          {changes.additions > 0 && <span className="text-(--color-diff-add-text)">+{changes.additions}</span>}
          {changes.deletions > 0 && <span className="text-(--color-diff-del-text)">−{changes.deletions}</span>}
        </span>
      </>
    )
    description = `${files} changed, ${plural(changes.additions, 'line')} added, ${changes.deletions} removed`
  } else {
    body = (
      <>
        <span
          aria-hidden="true"
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', mode === 'plan' ? 'bg-(--color-info)' : 'bg-(--color-text-subtle)')}
        />
        <span className={cn('shrink-0 font-medium', mode === 'plan' && 'text-(--accent-blue-text)')}>{modeLabel}</span>
      </>
    )
    description = `${modeLabel} mode`
  }

  const stop = (event: React.MouseEvent) => event.stopPropagation()

  return (
    <div data-island={kind} data-mode={mode} className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        aria-label="Expand input bar"
        aria-describedby={descriptionId}
        onClick={(event) => {
          stop(event)
          onExpand()
        }}
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:text-(--color-text) md:h-7"
      >
        {body}
      </button>
      <span id={descriptionId} className="sr-only">{description}</span>
      {kind === 'waiting' && resolver.error && (
        <span role="alert" className="sr-only">{resolver.error}</span>
      )}
      {kind === 'waiting' && choice?.options.map((option) => (
        <button
          key={option.label}
          type="button"
          aria-label={`Answer ${option.label}${option.recommended ? ' (recommended)' : ''}`}
          title={option.description ?? undefined}
          disabled={resolver.submitting}
          onClick={(event) => {
            stop(event)
            resolver.answer([[option.label]])
          }}
          className={cn(
            CHOICE,
            option.recommended ? 'border-(--color-border-strong) bg-(--bg-key) font-medium' : 'border-(--color-border) bg-(--bg-card)',
          )}
        >
          <span className="max-w-40 truncate">{option.label}</span>
        </button>
      ))}
      {kind === 'waiting' && (!choice || choice.custom) && (
        <button
          type="button"
          aria-label="Go to the question"
          onClick={(event) => {
            stop(event)
            goToQuestion()
          }}
          className={ACTION}
        >
          {choice ? 'Other…' : 'Answer'}
        </button>
      )}
      {kind === 'done' && onReviewChanges && (
        <button
          type="button"
          aria-label="Review changes"
          onClick={(event) => {
            stop(event)
            onReviewChanges()
          }}
          className={ACTION}
        >
          Review
        </button>
      )}
      {kind === 'running' && onStop && (
        <button
          type="button"
          aria-label="Stop generation"
          onClick={(event) => {
            stop(event)
            onStop()
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-(--bg-send) bg-(--bg-send) text-(--color-text-on-accent) transition duration-100 hover:opacity-90 active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 md:h-7 md:w-7"
        >
          <Square size={10} fill="currentColor" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
