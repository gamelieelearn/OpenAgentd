import { AlertCircle, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * A failure in the transcript. Only the failure a finished turn ended with
 * carries actions; the caller decides which one that is.
 */
export function ErrorCard({ title, message, onRetry, onSwitchModel }: {
  /** Omitted when the message is the whole story. */
  title?: string
  message: string
  /** Resend the latest prompt with the session's current model. */
  onRetry?: () => void
  /** Pick another model; it applies from the next message, so Retry after. */
  onSwitchModel?: () => void
}) {
  return (
    <div className="my-2 rounded-md border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs">
      <div className="flex items-start gap-1.5 text-(--color-error)">
        <AlertCircle size={14} className="mt-px shrink-0" aria-hidden="true" />
        {title
          ? <span className="font-medium">{title}</span>
          : <p className="leading-relaxed break-words">{message}</p>}
      </div>
      {title && <p className="mt-1 text-(--color-error)/90 leading-relaxed break-words">{message}</p>}
      {(onRetry || onSwitchModel) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {onRetry && (
            <Button size="xs" onClick={onRetry}>
              <RotateCcw aria-hidden="true" />
              Retry
            </Button>
          )}
          {onSwitchModel && (
            <Button size="xs" variant="subtle" onClick={onSwitchModel}>
              <Sparkles aria-hidden="true" />
              Switch model
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
