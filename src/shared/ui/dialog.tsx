import { tr } from '@/shared/i18n/messages'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from './button'

const Dialog = BaseDialog.Root
const DialogTrigger = BaseDialog.Trigger
const DialogClose = BaseDialog.Close

function DialogBackdrop({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Backdrop>) {
  return (
    <BaseDialog.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        'air-dialog-backdrop fixed inset-0 z-40 bg-(--backdrop-shade) backdrop-blur-[2px]',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & {
  showCloseButton?: boolean
}) {
  return (
    <BaseDialog.Portal>
      <DialogBackdrop />
      <BaseDialog.Viewport className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto p-4 outline-none">
        <BaseDialog.Popup
          data-slot="dialog-content"
          className={cn(
            'air-dialog-popup relative flex max-h-[calc(100dvh-2rem)] w-full max-w-[480px] flex-col rounded-[12px] border border-border bg-popover p-5 text-popover-foreground shadow-(--shadow-popover) outline-none',
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <BaseDialog.Close
              render={<Button variant="ghost" size="icon-sm" aria-label={tr("关闭")} />}
              className="absolute top-3.5 right-3.5"
            >
              <X />
            </BaseDialog.Close>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex items-center justify-between gap-3 pb-3', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex items-center justify-between gap-2 pt-4', className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title
      data-slot="dialog-title"
      className={cn('text-base font-semibold leading-tight tracking-tight text-foreground', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description
      data-slot="dialog-description"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
}
