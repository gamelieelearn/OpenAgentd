import { MarkdownBlock } from '@/utils/markdown'
import { useSmoothStream } from '@/hooks/useSmoothStream'

interface LazyMarkdownBlockProps {
  content: string
  sessionId?: string
  isStreaming?: boolean
}

export function LazyMarkdownBlock({ content, sessionId, isStreaming = false }: LazyMarkdownBlockProps) {
  const smoothedContent = useSmoothStream(content, isStreaming)
  const displayContent = isStreaming ? smoothedContent : content

  return <MarkdownBlock content={displayContent} sessionId={sessionId} isStreaming={isStreaming} />
}
