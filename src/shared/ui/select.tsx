import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

const Select = BaseSelect.Root
const SelectGroup = BaseSelect.Group
const SelectValue = BaseSelect.Value

function SelectTrigger({
  className,
  children,
  showIcon = true,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger> & { showIcon?: boolean }) {
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-[7px] border border-input bg-input-bg px-2.5 text-xs text-foreground shadow-2xs outline-none select-none transition-[border-color,background-color,box-shadow] duration-150 hover:border-accent-border focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/25 data-popup-open:border-primary disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
      {showIcon && (
        <BaseSelect.Icon className="ml-auto flex shrink-0 items-center text-muted-foreground transition-transform duration-150 data-popup-open:rotate-180">
          <ChevronDown className="size-3.5" />
        </BaseSelect.Icon>
      )}
    </BaseSelect.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof BaseSelect.Popup> & {
  side?: React.ComponentProps<typeof BaseSelect.Positioner>['side']
  align?: React.ComponentProps<typeof BaseSelect.Positioner>['align']
  sideOffset?: number
}) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        className="z-50 outline-none"
      >
        <BaseSelect.Popup
          data-slot="select-content"
          className={cn(
            'air-popup air-scroll max-h-72 min-w-[max(140px,var(--anchor-width))] max-w-[min(380px,calc(100vw-24px))] overflow-y-auto rounded-[9px] border border-accent-border/45 bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) outline-none',
            className,
          )}
          {...props}
        >
          <BaseSelect.List className="flex flex-col gap-0.5">{children}</BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
}

function SelectGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.GroupLabel>) {
  return (
    <BaseSelect.GroupLabel
      data-slot="select-label"
      className={cn('px-2 py-1 text-[12px] font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-7.5 w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1 text-xs text-popover-foreground outline-none select-none transition-colors data-highlighted:bg-accent data-selected:bg-accent-soft data-selected:font-medium data-selected:text-primary dark:data-selected:bg-primary/18 data-disabled:pointer-events-none data-disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemText className="truncate">{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="flex shrink-0 items-center text-primary">
        <Check className="size-3.5" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.Separator>) {
  return (
    <BaseSelect.Separator
      data-slot="select-separator"
      className={cn('my-1 h-px bg-border-subtle', className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
