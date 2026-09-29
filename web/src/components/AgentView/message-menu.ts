/**
 * What the reply context menu copies: a reply as plain text or Markdown.
 */
import type { ContentBlock } from '@/api/types'
import { extractSleepPrefix, lastTurnText } from '@/utils/format'

/** Marks a set-aside code span; a private-use character never typed in prose. */
const SPAN_MARK = '\uE000'

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
