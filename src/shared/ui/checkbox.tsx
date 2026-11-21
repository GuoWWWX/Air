import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Check, Minus } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

export function Checkbox({
  className,
  indeterminate,
  ...props
}: React.ComponentProps<typeof BaseCheckbox.Root>) {
  return (
    <BaseCheckbox.Root
      data-slot="checkbox"
      indeterminate={indeterminate}
      className={cn(
        'peer inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-(--checkbox-border) bg-input-bg text-primary-foreground shadow-2xs outline-none transition-[background-color,border-color,box-shadow] duration-120 hover:border-primary/70 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {indeterminate ? <Minus className="size-3 stroke-[2.6]" /> : <Check className="size-3 stroke-[2.6]" />}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  )
}
