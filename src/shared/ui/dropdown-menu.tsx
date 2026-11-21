import { Menu as BaseMenu } from '@base-ui/react/menu'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

function DropdownMenu({ modal = false, ...props }: React.ComponentProps<typeof BaseMenu.Root>) {
  return <BaseMenu.Root modal={modal} {...props} />
}

const DropdownMenuTrigger = BaseMenu.Trigger
const DropdownMenuGroup = BaseMenu.Group

function DropdownMenuContent({
  className,
  side = 'bottom',
  align = 'end',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof BaseMenu.Popup> & {
  side?: React.ComponentProps<typeof BaseMenu.Positioner>['side']
  align?: React.ComponentProps<typeof BaseMenu.Positioner>['align']
  sideOffset?: number
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50 outline-none">
        <BaseMenu.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'air-popup min-w-36 overflow-hidden rounded-[9px] border border-border bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) outline-none',
            className,
          )}
          {...props}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseMenu.GroupLabel>) {
  return (
    <BaseMenu.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn('px-2 py-1 text-[12px] font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof BaseMenu.Item> & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <BaseMenu.Item
      data-slot="dropdown-menu-item"
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

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseMenu.Separator>) {
  return (
    <BaseMenu.Separator
      data-slot="dropdown-menu-separator"
      className={cn('my-1 h-px bg-border-subtle', className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
