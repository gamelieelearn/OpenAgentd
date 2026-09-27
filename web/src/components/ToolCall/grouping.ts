/**
 * Folding runs of tool calls into one summary row.
 *
 * A *run* is a maximal stretch of work rows inside one assistant turn: tool
 * calls plus the folded thinking traces and blank text chunks between them.
 * Prose, questions, and interactive app results end a run; they are what the
 * reader is looking for, so they are never folded away.
 */
import type { ContentBlock } from '@/api/types'

import { parsePatchText } from './diffUtils'
import { isFailedResult } from './toolResultStatus'

/** Below this many rows a summary saves nothing over the rows themselves. */
const MIN_GROUP_ROWS = 3
const MIN_GROUP_TOOLS = 2

export type TurnSegment =
  | { kind: 'block'; index: number }
  /** ``blocks.slice(start, end)`` folded behind ``summary``. */
  | { kind: 'group'; start: number; end: number; summary: ToolRunSummary }

export interface ToolRunSummary {
  /** e.g. "Edited 1 file, read 2 files, ran 3 commands". */
  label: string
  toolCount: number
  failed: number
  additions: number
  deletions: number
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

/** Files a ``patch`` call touches, each with its own line counts. */
export function patchFileStats(args: string | undefined): PatchFileStat[] {
  const patchText = parseArgs(args)?.patch_text
  if (typeof patchText !== 'string') return []
  return parsePatchText(patchText).map((diff) => ({
    path: diff.moveTo ?? diff.path,
    kind: diff.kind,
    additions: diff.lines.filter((line) => line.type === 'added').length,
    deletions: diff.lines.filter((line) => line.type === 'removed').length,
  }))
}

function isGroupable(block: ContentBlock): boolean {
  if (block.type === 'thinking') return true
  if (block.type === 'text') return block.content.trim().length === 0
  if (block.type !== 'tool') return false
  // ``ask_user`` owns an interactive card; an MCP app renders a live UI.
  if (block.toolName === 'ask_user') return false
  return !(block.extra as { mcp_app?: unknown } | null | undefined)?.mcp_app
}

function worthGrouping(blocks: ContentBlock[]): boolean {
  return blocks.length >= MIN_GROUP_ROWS && blocks.filter((b) => b.type === 'tool').length >= MIN_GROUP_TOOLS
}

/**
 * Split a turn's blocks into rows and folded groups.
 *
 * While the turn is ``live``, the trailing run keeps its newest tool call (or
 * the first one still running, with parallel calls) and everything after it
 * outside the group, so progress stays visible and the group's count grows as
 * calls finish.
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
    if (live && end === blocks.length) {
      let firstLive = end
      for (let j = start; j < end; j += 1) {
        if (blocks[j].type === 'tool' && !blocks[j].toolDone) { firstLive = j; break }
      }
      for (let j = end - 1; j >= start; j -= 1) {
        if (blocks[j].type === 'tool') { firstLive = Math.min(firstLive, j); break }
      }
      end = firstLive
    }
    const run = blocks.slice(start, end)
    if (worthGrouping(run)) {
      segments.push({ kind: 'group', start, end, summary: summarizeToolRun(run) })
    } else {
      for (let j = start; j < end; j += 1) segments.push({ kind: 'block', index: j })
    }
    for (let j = end; j < i; j += 1) segments.push({ kind: 'block', index: j })
  }
  return segments
}

type Category = 'edit' | 'read' | 'search' | 'command' | 'fetch' | 'other'

const CATEGORY_BY_TOOL: Record<string, Category> = {
  patch: 'edit',
  read: 'read',
  grep: 'search',
  glob: 'search',
  lsp: 'search',
  web_search: 'search',
  shell: 'command',
  bg: 'command',
  web_fetch: 'fetch',
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function summarizeToolRun(blocks: ContentBlock[]): ToolRunSummary {
  const edited = new Set<string>()
  const read = new Set<string>()
  const counts: Record<Category, number> = { edit: 0, read: 0, search: 0, command: 0, fetch: 0, other: 0 }
  let toolCount = 0
  let failed = 0
  let additions = 0
  let deletions = 0

  for (const block of blocks) {
    if (block.type !== 'tool') continue
    toolCount += 1
    if (isFailedResult(block.toolResult)) failed += 1
    const category = CATEGORY_BY_TOOL[block.toolName ?? ''] ?? 'other'
    counts[category] += 1
    if (category === 'edit') {
      for (const file of patchFileStats(block.toolArgs)) {
        edited.add(file.path)
        additions += file.additions
        deletions += file.deletions
      }
    } else if (category === 'read') {
      const path = parseArgs(block.toolArgs)?.path
      // Unparsable args still count as a read, just not a distinct file.
      read.add(typeof path === 'string' ? path : `#${block.id}`)
    }
  }

  const parts: string[] = []
  if (counts.edit) parts.push(`edited ${plural(edited.size || counts.edit, 'file')}`)
  if (counts.read) parts.push(`read ${plural(read.size, 'file')}`)
  if (counts.search) parts.push(`ran ${plural(counts.search, 'search', 'searches')}`)
  if (counts.command) parts.push(`ran ${plural(counts.command, 'command')}`)
  if (counts.fetch) parts.push(`fetched ${plural(counts.fetch, 'page')}`)
  if (counts.other) parts.push(parts.length ? `used ${plural(counts.other, 'other tool')}` : `used ${plural(counts.other, 'tool')}`)
  const label = parts.join(', ')

  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    toolCount,
    failed,
    additions,
    deletions,
  }
}
