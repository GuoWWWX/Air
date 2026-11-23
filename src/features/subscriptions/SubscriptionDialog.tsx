import { tr } from '@/shared/i18n/messages'
import { X } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'

export function SubscriptionDialog({
  title,
  pending,
  onClose,
  onSubmit,
  children,
  footer,
}: {
  title: string
  pending: boolean
  onClose: () => void
  onSubmit: (event: FormEvent) => void
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Dialog
      open
      onOpenChange={(open, eventDetails) => {
        if (!open) {
          if (pending) {
            eventDetails.cancel()
            return
          }
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-[480px] gap-0 p-5">
        <form className="flex min-h-0 flex-col gap-4" onSubmit={onSubmit}>
          <DialogHeader className="pb-0">
            <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">{title}</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={tr("关闭对话框")}
              onClick={onClose}
            >
              <X />
            </Button>
          </DialogHeader>

          <div className="air-scroll flex max-h-[calc(100dvh-185px)] flex-col gap-4 overflow-y-auto pr-0.5">
            {children}
          </div>

          {footer && <DialogFooter className="justify-end pt-1">{footer}</DialogFooter>}
        </form>
      </DialogContent>
    </Dialog>
  )
}
