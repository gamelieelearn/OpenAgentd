/**
 * What the reply context menu copies and opens: a reply as plain text or
 * Markdown, and the whole session as one Markdown document.
 */
import type { ContentBlock } from '@/api/types'
import { getToolDisplay } from '@/components/ToolCall/display'
import { patchFileStats } from '@/components/ToolCall/diffUtils'
import { isFailedResult } from '@/components/ToolCall/toolResultStatus'
import { useAgentStore } from '@/stores/useAgentStore'
import { liveBlockTail } from '@/utils/blocks'
import { extractSleepPrefix, lastTurnText } from '@/utils/format'

/** Longest tool detail kept in the session document. */
const TOOL_DETAIL_MAX = 120
/** Marks a set-aside code span; a private-use character never typed in prose. */
const SPAN_MARK = '\uE000'
/** Arguments that say what a call did, most telling first; a document wants full paths. */
const DETAIL_ARGS = ['command', 'pattern', 'query', 'url', 'path']
/** Bounds the history walk; a page is a few dozen messages. */
const MAX_HISTORY_PAGES = 200

/**
 * Right-click belongs to the browser on a link, in a field, or over a
 * selection: those menus open links and copy exactly what is selected.
 */
export function shouldOpenReplyMenu(target: EventTarget | null, selectedText: string): boolean {
  if (selectedText.trim()) return false
  if (!(target instanceof Element)) return true
  return !target.closest('a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

/** The text block under the pointer, else the turn's final answer. */
export function replyMarkdown(turnBlocks: ContentBlock[], blockId: string | null): string {
  const block = blockId ? turnBlocks.find((b) => b.id === blockId) : undefined
  if (block?.type === 'text') return extractSleepPrefix(block.content) ?? block.content
  return lastTurnText(turnBlocks)
}

function plainInline(text: string): string {
  // Code spans are set aside first, so their contents keep every character
  // and a link wrapping one (``[`a.ts`](a.ts)``) still reads as a link.
  const spans: string[] = []
  const shielded = text.replace(/(`+)(.+?)\1/g, (_, _ticks, code: string) => {
    spans.push(code.trim())
    return `${SPAN_MARK}${spans.length - 1}${SPAN_MARK}`
  })
  return shielded
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(new RegExp(`${SPAN_MARK}(\\d+)${SPAN_MARK}`, 'g'), (_, index: string) => spans[Number(index)])
}

/** Markdown as someone would retype it: markup gone, code and link targets kept. */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      else out.push(line)
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('')
      continue
    }
    out.push(plainInline(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s{0,3}(>\s?)+/, '')))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function toolDetail(name: string, args: string | undefined): string {
  if (name === 'patch') {
    const paths = patchFileStats(args).map((stat) => stat.path)
    if (paths.length > 0) return paths.join(', ')
  }
  let parsed: Record<string, unknown> | null = null
  try {
    const value: unknown = args ? JSON.parse(args) : null
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch { /* partial arguments fall through to the display header */ }
  for (const key of DETAIL_ARGS) {
    const value = parsed?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0]
  }
  const display = getToolDisplay(name, args)
  return display.headerTitle ?? display.formattedArgs?.split('\n')[0] ?? ''
}

function toolLine(block: ContentBlock): string {
  const name = block.toolName || 'tool'
  const raw = toolDetail(name, block.toolArgs)
  const detail = raw.length > TOOL_DETAIL_MAX ? `${raw.slice(0, TOOL_DETAIL_MAX - 1)}…` : raw
  const failed = block.toolDone && isFailedResult(block.toolResult) ? ' (failed)' : ''
  return `- \`${name}\`${detail ? ` ${detail.replace(/`/g, "'")}` : ''}${failed}`
}

/**
 * The session as one document: each prompt, report, and answer under its own
 * heading, tool calls as one-line bullets. Thinking is left out.
 */
export function sessionToMarkdown(
  blocks: ContentBlock[],
  title: string | null,
  { incomplete = false }: { incomplete?: boolean } = {},
): string {
  const chunks = [`# ${title?.trim() || 'Untitled session'}`]
  if (incomplete) chunks.push('> Earlier messages could not be loaded, so they are missing here.')
  let inAssistant = false
  let inToolList = false
  const push = (chunk: string, { tool = false } = {}) => {
    if (tool && inToolList) chunks[chunks.length - 1] += `\n${chunk}`
    else chunks.push(chunk)
    inToolList = tool
  }
  const assistant = () => {
    if (!inAssistant) push('## Assistant')
    inAssistant = true
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'user': {
        const from = typeof block.extra?.from_agent === 'string' ? block.extra.from_agent : null
        push(from ? `## Report from ${from}` : '## You')
        inAssistant = false
        if (block.content.trim()) push(block.content.trim())
        // ``@path`` mentions already read as text in the prompt.
        const names = (block.attachments ?? [])
          .filter((att) => att.source !== 'mention')
          .map((att) => att.original_name || att.filename)
          .filter(Boolean)
        if (names.length > 0) push(`*Attached: ${names.join(', ')}*`)
        break
      }
      case 'text': {
        const text = (extractSleepPrefix(block.content) ?? block.content).trim()
        if (!text) break
        assistant()
        push(text)
        break
      }
      case 'tool':
        assistant()
        push(toolLine(block), { tool: true })
        break
      case 'provider_status': {
        const status = block.extra?.status
        if (status !== 'error' && status !== 'exhausted' && block.extra?.category !== 'provider') break
        assistant()
        const heading = typeof block.extra?.title === 'string' ? block.extra.title : 'Error'
        const message = typeof block.extra?.message === 'string' ? block.extra.message : block.content
        push(`> **${heading}:** ${message}`)
        break
      }
      case 'compaction':
        push('---')
        push('*Earlier conversation compacted.*')
        inAssistant = false
        break
    }
  }
  return `${chunks.join('\n\n')}\n`
}

/** A download name for the session document. */
export function sessionFileName(title: string | null): string {
  return `${title?.replace(/[\\/:*?"<>|\n]+/g, ' ').trim() || 'session'}.md`
}

/**
 * The open session as Markdown, after loading every earlier page, or
 * ``null`` when the user switched sessions meanwhile.
 */
export async function loadSessionMarkdown(): Promise<string | null> {
  const sessionId = useAgentStore.getState().sessionId
  let incomplete = false
  for (let page = 0; page < MAX_HISTORY_PAGES && useAgentStore.getState().hasMore; page += 1) {
    const cursor = useAgentStore.getState().nextCursor
    try {
      await useAgentStore.getState().loadOlderMessages()
    } catch {
      incomplete = true
      break
    }
    if (useAgentStore.getState().sessionId !== sessionId) return null
    // A load already in flight returns at once; stop rather than spin.
    if (useAgentStore.getState().nextCursor === cursor) break
  }
  const state = useAgentStore.getState()
  const stream = (state.leadName ? state.agentStreams[state.leadName] : undefined) ?? Object.values(state.agentStreams)[0]
  const blocks = stream ? [...stream.blocks, ...liveBlockTail(stream.blocks, stream.currentBlocks)] : []
  return sessionToMarkdown(blocks, state.sessionTitle, { incomplete: incomplete || state.hasMore })
}
