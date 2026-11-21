import { Input as BaseInput } from '@base-ui/react/input'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

export function Input({
  className,
  type,
  ...props
}: React.ComponentProps<typeof BaseInput>) {
  return (
    <BaseInput
      data-slot="input"
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-[7px] border border-input bg-input-bg px-2.5 text-xs text-foreground shadow-2xs outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted-foreground/70 focus:border-primary focus:ring-3 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/15',
        className,
      )}
      {...props}
    />
  )
}
