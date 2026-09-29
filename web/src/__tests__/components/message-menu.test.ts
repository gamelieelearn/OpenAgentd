import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import {
  markdownToPlainText,
  replyMarkdown,
  shouldOpenReplyMenu,
} from '@/components/AgentView/message-menu'

describe('markdownToPlainText', () => {
  it('drops heading, quote, and emphasis markup but keeps list markers', () => {
    expect(markdownToPlainText('## Plan\n\n> **Note:** this is _important_\n\n- one\n- ~~two~~ three')).toBe(
      'Plan\n\nNote: this is important\n\n- one\n- two three',
    )
  })

  it('keeps link targets and image alt text', () => {
    expect(markdownToPlainText('See [the docs](https://x.dev/a) or https://x.dev and ![diagram](d.png)')).toBe(
      'See the docs (https://x.dev/a) or https://x.dev and diagram',
    )
    expect(markdownToPlainText('[https://x.dev](https://x.dev)')).toBe('https://x.dev')
  })

  it('unwraps code without touching what is inside it', () => {
    expect(markdownToPlainText('Run `a*b*c` in [`src/app.ts`](src/app.ts):\n\n```ts\nconst x = **y**\n```\n\nDone.')).toBe(
      'Run a*b*c in src/app.ts (src/app.ts):\n\nconst x = **y**\n\nDone.',
    )
  })

  it('leaves snake_case and lone asterisks alone', () => {
    expect(markdownToPlainText('call load_session_file with 2 * 3')).toBe('call load_session_file with 2 * 3')
  })
})

describe('replyMarkdown', () => {
  const turn: ContentBlock[] = [
    { id: 't1', type: 'text', content: 'Looking at the code.' },
    { id: 'x1', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"a.ts"}', toolDone: true, toolResult: 'ok' },
    { id: 't2', type: 'text', content: 'Here is the **fix**.' },
  ]

  it('is the text block the pointer is on', () => {
    expect(replyMarkdown(turn, 't1')).toBe('Looking at the code.')
  })

  it('falls back to the final answer elsewhere in the turn', () => {
    expect(replyMarkdown(turn, 'x1')).toBe('Here is the **fix**.')
    expect(replyMarkdown(turn, null)).toBe('Here is the **fix**.')
  })
})

describe('shouldOpenReplyMenu', () => {
  function within(html: string, selector: string): Element {
    const root = document.createElement('div')
    root.innerHTML = html
    return root.querySelector(selector)!
  }

  it('opens on prose with nothing selected', () => {
    expect(shouldOpenReplyMenu(within('<p><strong>hi</strong></p>', 'strong'), '')).toBe(true)
  })

  it('leaves links, fields, and selections to the native menu', () => {
    expect(shouldOpenReplyMenu(within('<a href="https://x.dev"><span>x</span></a>', 'span'), '')).toBe(false)
    expect(shouldOpenReplyMenu(within('<textarea></textarea>', 'textarea'), '')).toBe(false)
    expect(shouldOpenReplyMenu(within('<div contenteditable="true"><b>x</b></div>', 'b'), '')).toBe(false)
    expect(shouldOpenReplyMenu(within('<p>hi</p>', 'p'), 'hi')).toBe(false)
  })
})
