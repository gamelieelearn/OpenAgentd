/**
 * Folding runs of read-only tool calls into one "Explored" row, plus the
 * files a ``patch`` call touches.
 *
 * A *run* is a maximal stretch of successful read-only calls (and blank text
 * chunks, which render nothing) inside one assistant turn. Anything the reader
 * needs to see ends it and keeps its own row: the agent's prose and thinking,
 * edits, shell commands, failures, questions, and interactive app results.
 */
import type { ContentBlock } from '@/api/types'

import { parsePatchText, type FileDiff } from './diffUtils'
import { isFailedResult } from './toolResultStatus'

const MIN_GROUP_TOOLS = 2

type ExploreKind = 'read' | 'search' | 'fetch'

/** Read-only tools that fold, and what the summary counts them as. */
const EXPLORE_KIND: Record<string, ExploreKind> = {
  read: 'read',
  grep: 'search',
  glob: 'search',
  lsp: 'search',
  recall: 'search',
  web_search: 'search',
  web_fetch: 'fetch',
}

export type TurnSegment =
  | { kind: 'block'; index: number }
  /** ``blocks.slice(start, end)`` folded behind ``summary``. */
  | { kind: 'group'; start: number; end: number; summary: ToolRunSummary }

export interface ToolRunSummary {
  /** e.g. "Explored · 6 reads, 3 searches". */
  label: string
  toolCount: number
}

export interface PatchFileStat {
  path: string
  kind: 'add' | 'update' | 'delete'
  additions: number
  deletions: number
}

function parseArgs(args: string | undefined): Record<string, unknown> | null {
  if (!args) return null
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function patchText(args: string | undefined): string | null {
  const patchText = parseArgs(args)?.patch_text
  return typeof patchText === 'string' ? patchText : null
}

function diffStat(diff: FileDiff): PatchFileStat {
  return {
    path: diff.moveTo ?? diff.path,
    kind: diff.kind,
    additions: diff.lines.filter((line) => line.type === 'added').length,
    deletions: diff.lines.filter((line) => line.type === 'removed').length,
  }
}

/** Files a ``patch`` call touches, each with its own line counts. */
export function patchFileStats(args: string | undefined): PatchFileStat[] {
  const text = patchText(args)
  return text === null ? [] : parsePatchText(text).map(diffStat)
}

function isGroupable(block: ContentBlock): boolean {
  if (block.type === 'text') return block.content.trim().length === 0
  if (block.type !== 'tool' || !Object.hasOwn(EXPLORE_KIND, block.toolName ?? '')) return false
  if (!block.toolDone || isFailedResult(block.toolResult)) return false
  // An MCP app renders a live UI in place of its result.
  return !(block.extra as { mcp_app?: unknown } | null | undefined)?.mcp_app
}

/**
 * Split a turn's blocks into rows and folded groups.
 *
 * While the turn is ``live`` and only running calls follow a run, the run
 * keeps its newest call outside the group, so progress stays visible and the
 * group's count grows as calls finish.
 */
export function groupToolRuns(blocks: ContentBlock[], { live }: { live: boolean }): TurnSegment[] {
  const segments: TurnSegment[] = []
  let i = 0
  while (i < blocks.length) {
    if (!isGroupable(blocks[i])) {
      segments.push({ kind: 'block', index: i })
      i += 1
      continue
    }
    const start = i
    while (i < blocks.length && isGroupable(blocks[i])) i += 1
    let end = i
    if (live && blocks.slice(i).every((b) => b.type === 'tool' && !b.toolDone)) {
      for (let j = end - 1; j >= start; j -= 1) {
        if (blocks[j].type === 'tool') { end = j; break }
      }
    }
    const run = blocks.slice(start, end)
    if (run.filter((b) => b.type === 'tool').length >= MIN_GROUP_TOOLS) {
      segments.push({ kind: 'group', start, end, summary: summarizeToolRun(run) })
    } else {
      for (let j = start; j < end; j += 1) segments.push({ kind: 'block', index: j })
    }
    for (let j = end; j < i; j += 1) segments.push({ kind: 'block', index: j })
  }
  return segments
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function summarizeToolRun(blocks: ContentBlock[]): ToolRunSummary {
  const counts: Record<ExploreKind, number> = { read: 0, search: 0, fetch: 0 }
  for (const block of blocks) {
    const kind = block.type === 'tool' ? EXPLORE_KIND[block.toolName ?? ''] : undefined
    if (kind) counts[kind] += 1
  }
  const parts = [
    counts.read && plural(counts.read, 'read'),
    counts.search && plural(counts.search, 'search', 'searches'),
    counts.fetch && plural(counts.fetch, 'fetch', 'fetches'),
  ].filter(Boolean)
  return {
    label: `Explored · ${parts.join(', ')}`,
    toolCount: counts.read + counts.search + counts.fetch,
  }
}
