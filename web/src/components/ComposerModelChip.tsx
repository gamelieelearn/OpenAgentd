/**
 * ComposerModelChip — the session's model and thinking level on the
 * expanded composer. A click opens Session Settings, where both change.
 */
import { Sparkles } from 'lucide-react'

import { shortModelName } from '@/utils/format'

export function ComposerModelChip({
  model,
  thinkingLevel,
  fastMode = false,
  onOpen,
}: {
  model: string | null | undefined
  thinkingLevel?: string | null
  fastMode?: boolean
  onOpen: () => void
}) {
  const name = shortModelName(model)
  const thinking = thinkingLevel && thinkingLevel !== 'off' ? thinkingLevel : null
  const label = [
    name ? `Model ${name}` : 'Default model',
    thinking ? `thinking ${thinking}` : null,
    fastMode ? 'fast mode' : null,
  ].filter(Boolean).join(', ')
  return (
    <button
      type="button"
      aria-label={`${label}. Open Session Settings`}
      title={model ?? undefined}
      onClick={onOpen}
      className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-(--color-border) bg-(--bg-card) px-2 text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7"
    >
      <Sparkles size={11} aria-hidden="true" className="shrink-0 text-(--color-accent)" />
      <span className="min-w-0 truncate font-mono text-[11px]">{name ?? 'Default model'}</span>
      {thinking && <span className="shrink-0 text-[11px] text-(--color-text-muted)">{thinking}</span>}
      {fastMode && <span className="shrink-0 rounded-xs bg-(--accent-orange-soft) px-1 font-mono text-[11px] text-(--accent-orange-text)">fast</span>}
    </button>
  )
}
