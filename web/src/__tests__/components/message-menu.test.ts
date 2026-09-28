import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import {
  markdownToPlainText,
  replyMarkdown,
  sessionToMarkdown,
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

describe('sessionToMarkdown', () => {
  it('writes prompts, answers, tool calls, reports, and errors under headings', () => {
    const blocks: ContentBlock[] = [
      {
        id: 'u1',
        type: 'user',
        content: 'Fix the bug @src/a.ts',
        attachments: [
          { filename: 'f3a9.txt', original_name: 'log.txt', source: 'upload' },
          { filename: 'a.ts', source: 'mention' },
        ],
      },
      { id: 'h1', type: 'thinking', content: 'hmm' },
      { id: 'x1', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"src/a.ts"}', toolDone: true, toolResult: 'ok' },
      { id: 'x2', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"npm test"}', toolDone: true, toolResult: 'Error: exit 1' },
      { id: 'a1', type: 'text', content: 'Fixed.' },
      { id: 'r1', type: 'user', content: 'Explorer found nothing.', extra: { from_agent: 'explorer' } },
      { id: 'e1', type: 'provider_status', content: 'Rate limit exceeded', extra: { status: 'error', title: 'Provider Error', message: 'Rate limit exceeded' } },
    ]

    expect(sessionToMarkdown(blocks, 'Bug hunt')).toBe([
      '# Bug hunt',
      '## You',
      'Fix the bug @src/a.ts',
      '*Attached: log.txt*',
      '## Assistant',
      '- `read` src/a.ts\n- `shell` npm test (failed)',
      'Fixed.',
      '## Report from explorer',
      'Explorer found nothing.',
      '## Assistant',
      '> **Provider Error:** Rate limit exceeded',
    ].join('\n\n') + '\n')
  })

  it('names an untitled session and says when earlier messages are missing', () => {
    const markdown = sessionToMarkdown([{ id: 'u1', type: 'user', content: 'hi' }], null, { incomplete: true })
    expect(markdown.startsWith('# Untitled session\n\n> Earlier messages could not be loaded')).toBe(true)
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
