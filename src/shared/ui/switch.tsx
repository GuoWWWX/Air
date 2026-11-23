import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

interface SwitchProps extends React.ComponentProps<typeof BaseSwitch.Root> {
  size?: 'default' | 'sm'
  tone?: 'primary' | 'success'
}

export function Switch({ className, size = 'default', tone = 'primary', ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex shrink-0 cursor-pointer items-center rounded-full bg-(--switch-track) p-0.5 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45',
        tone === 'success'
          ? 'data-checked:bg-[#008b78] dark:data-checked:bg-[#0ea58a]'
          : 'data-checked:bg-[#2956d4] dark:data-checked:bg-[#3b6ae8]',
        size === 'sm' ? 'h-3.5 w-6 border-0' : 'h-[18px] w-8 border border-transparent',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-white shadow-xs transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none data-unchecked:translate-x-0 dark:bg-[#f4f4f5]',
          size === 'sm'
            ? 'size-2.5 data-checked:translate-x-2.5'
            : 'size-3.5 data-checked:translate-x-3.5',
        )}
      />
    </BaseSwitch.Root>
  )
}
