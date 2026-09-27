/**
 * What the collapsed composer says about the lead's turn: the step it is on,
 * how long it has run, and what the last turn changed.
 */
import type { ContentBlock } from '@/api/types'
import { getToolDisplay } from './ToolCall/display'
import { summarizeTurnChanges, type TurnChangeSummary } from './ToolCall/grouping'

/** A chunk that has streamed only whitespace renders nothing yet. */
function isBlank(block: ContentBlock): boolean {
  return (block.type === 'text' || block.type === 'thinking') && block.content.trim().length === 0
}

function titleCase(name: string): string {
  return name.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function toolStep(block: ContentBlock): string {
  const name = block.toolName ?? ''
  const title = getToolDisplay(name, block.toolArgs).headerTitle
  switch (name) {
    case 'read':
      return title && title !== 'file' ? `Reading ${title}` : 'Reading a file'
    case 'patch':
      return title && title !== 'patch' ? `Editing ${title}` : 'Editing files'
    case 'shell':
      return title ?? 'Running a command'
    case 'web_search':
      return title ? `Searching the web for ${title}` : 'Searching the web'
    case 'web_fetch':
      return title ? `Fetching ${title}` : 'Fetching a page'
    case 'ask_user':
      return 'Asking you'
    default:
      return title ?? (titleCase(name) || 'Using a tool')
  }
}

/** One line for what the lead is doing, read from its newest live block. */
export function currentStep(blocks: ContentBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (isBlank(block)) continue
    switch (block.type) {
      case 'tool': {
        // Parallel calls finish out of order: a later call can be done while
        // an earlier one in the same run is still going.
        for (let j = i; j >= 0 && blocks[j].type === 'tool'; j -= 1) {
          if (!blocks[j].toolDone) return toolStep(blocks[j])
        }
        return 'Thinking'
      }
      case 'thinking':
        return 'Thinking'
      case 'text':
        return 'Writing'
      case 'compaction':
        return 'Compacting'
      case 'provider_status':
        return block.extra?.status === 'waiting_quota' ? 'Waiting for quota' : 'Retrying'
      default:
        return 'Starting'
    }
  }
  return 'Starting'
}

/** ``m:ss``, or ``h:mm:ss`` past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Files changed since the last prompt the user wrote. */
export function lastTurnChanges(blocks: ContentBlock[]): TurnChangeSummary {
  let start = blocks.length
  while (start > 0 && !(blocks[start - 1].type === 'user' && !blocks[start - 1].extra?.from_agent)) start -= 1
  return summarizeTurnChanges(blocks.slice(start))
}
