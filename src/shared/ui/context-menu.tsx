import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { ChevronRight } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

function ContextMenu(props: React.ComponentProps<typeof BaseContextMenu.Root>) {
  return <BaseContextMenu.Root {...props} />
}

const ContextMenuTrigger = BaseContextMenu.Trigger
const ContextMenuGroup = BaseContextMenu.Group
const ContextMenuSub = BaseContextMenu.SubmenuRoot

function ContextMenuContent({
  className,
  sideOffset = 2,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Popup> & {
  sideOffset?: number
}) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner sideOffset={sideOffset} className="z-50 outline-none">
        <BaseContextMenu.Popup
          data-slot="context-menu-content"
          className={cn(
            'air-popup min-w-44 overflow-hidden rounded-[9px] border border-border bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) outline-none',
            className,
          )}
          {...props}
        />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.SubmenuTrigger>) {
  return (
    <BaseContextMenu.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(
        'flex min-h-7.5 cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-xs text-popover-foreground outline-none select-none transition-colors data-highlighted:bg-muted data-popup-open:bg-muted data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </BaseContextMenu.SubmenuTrigger>
  )
}

function ContextMenuSubContent({
  className,
  sideOffset = 2,
  alignOffset = -4,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Popup> & {
  sideOffset?: number
  alignOffset?: number
}) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner
        side="inline-end"
        align="start"
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="z-50 outline-none"
      >
        <BaseContextMenu.Popup
          data-slot="context-menu-sub-content"
          className={cn(
            'air-popup min-w-40 overflow-hidden rounded-[9px] border border-border bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) outline-none',
            className,
          )}
          {...props}
        />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.GroupLabel>) {
  return (
    <BaseContextMenu.GroupLabel
      data-slot="context-menu-label"
      className={cn('px-2 py-1 text-[12px] font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Item> & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <BaseContextMenu.Item
      data-slot="context-menu-item"
      className={cn(
        'flex min-h-7.5 cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-xs outline-none select-none transition-colors data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
        variant === 'destructive'
          ? 'text-destructive data-highlighted:bg-danger-soft'
          : 'text-popover-foreground [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Separator>) {
  return (
    <BaseContextMenu.Separator
      data-slot="context-menu-separator"
      className={cn('my-1 h-px bg-border-subtle', className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
}
