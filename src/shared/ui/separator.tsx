import { Separator as BaseSeparator } from '@base-ui/react/separator'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof BaseSeparator>) {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
