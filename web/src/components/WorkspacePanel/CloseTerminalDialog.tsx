import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** ⌘W on a terminal with a running shell: stopping it cannot be undone. */
export function CloseTerminalDialog({ open, title, onConfirm, onCancel }: {
  open: boolean
  title: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Close terminal?</DialogTitle>
          <DialogDescription>
            {title} is still running. Closing it stops the shell and anything running in it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="p-3">
          <Button type="button" variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="danger-subtle" onClick={onConfirm} autoFocus>
            Close terminal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
