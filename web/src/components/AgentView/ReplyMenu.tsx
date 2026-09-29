import { Copy } from 'lucide-react'

import { CONTEXT_MENU_ITEM_CLASS, ContextMenu } from '@/components/ui/context-menu'
import { markdownToPlainText } from './message-menu'

/**
 * Right-click on a reply. Mouse-only by design: a long-press would fight
 * native text selection on touch. The footer's Copy already copies the Markdown.
 */
export function ReplyMenu({ at, markdown, onDismiss }: {
  at: { x: number; y: number }
  /** The reply under the pointer; empty when the turn said nothing. */
  markdown: string
  onDismiss: () => void
}) {
  const copy = (text: string) => {
    onDismiss()
    void navigator.clipboard.writeText(text).catch(() => {})
  }
  return (
    <ContextMenu at={at} label="Reply actions" onDismiss={onDismiss} className="min-w-48">
      <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS} disabled={!markdown} onClick={() => copy(markdownToPlainText(markdown))}>
        <Copy size={12} aria-hidden="true" />
        Copy
      </button>
      <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS} disabled={!markdown} onClick={() => copy(markdown)}>
        <Copy size={12} aria-hidden="true" />
        Copy as Markdown
      </button>
    </ContextMenu>
  )
}
