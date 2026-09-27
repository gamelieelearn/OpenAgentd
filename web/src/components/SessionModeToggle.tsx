import type { SessionInteractionMode } from '@/api/types'
import { cn } from '@/lib/utils'

const LABEL: Record<SessionInteractionMode, string> = { code: 'Code', plan: 'Plan' }

/**
 * The composer's mode chip: names the mode and switches to the other on a
 * click, as Tab does from the textarea. Plan takes the blue tint the
 * collapsed composer uses.
 */
export function SessionModeToggle({
  mode,
  pending = false,
  onChange,
  disabled = false,
}: {
  mode: SessionInteractionMode
  /**
   * True when `mode` is a switch queued behind an active turn. The backend
   * applies it when the turn closes rather than stopping the turn, so the
   * selection is shown as chosen but not yet in force.
   */
  pending?: boolean
  onChange: (mode: SessionInteractionMode) => void
  disabled?: boolean
}) {
  const other: SessionInteractionMode = mode === 'code' ? 'plan' : 'code'
  return (
    <button
      type="button"
      data-mode={mode}
      aria-label={pending ? `${LABEL[mode]} mode (applies after the current turn)` : `${LABEL[mode]} mode`}
      title={pending ? 'Applies when the current turn finishes' : `Switch to ${LABEL[other]} mode (Tab)`}
      disabled={disabled}
      onClick={() => onChange(other)}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors duration-(--motion-instant) disabled:cursor-default disabled:opacity-50 md:h-7',
        mode === 'plan'
          ? 'border-(--color-info)/50 bg-(--color-info-subtle) text-(--accent-blue-text)'
          : 'border-(--color-border) bg-(--bg-card) text-(--color-text-2) enabled:hover:bg-(--bg-key) enabled:hover:text-(--color-text)',
        pending && 'italic opacity-70',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 rounded-full', mode === 'plan' ? 'bg-(--color-info)' : 'bg-(--color-text-subtle)')}
      />
      {LABEL[mode]}
    </button>
  )
}
