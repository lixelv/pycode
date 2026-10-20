import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export interface ConfirmRequest {
  title: string
  description: string
  action: string
  destructive?: boolean
  onConfirm: () => void
}

/** Asks before something that cannot be undone. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => {
              request?.onConfirm()
              onClose()
            }}
          >
            {request?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
