import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

export interface SegmentedOption<Value extends string> {
  value: Value
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

interface SegmentedProps<Value extends string> {
  value: Value
  options: readonly SegmentedOption<Value>[]
  onChange: (value: Value) => void
  layoutId: string
  ariaLabel: string
  disabled?: boolean
  size?: 'xs' | 'sm' | 'md'
  fullWidth?: boolean
  className?: string
}

export function Segmented<Value extends string>({
  value,
  options,
  onChange,
  layoutId,
  ariaLabel,
  disabled,
  size = 'sm',
  fullWidth = false,
  className,
}: SegmentedProps<Value>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[8px] border border-border bg-muted/75 p-0.5 select-none',
        fullWidth && 'grid w-full',
        className,
      )}
      style={fullWidth ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map(option => {
        const active = value === option.value
        const isDisabled = Boolean(disabled || option.disabled)
        return (
          <button
            key={option.value}
            type="button"
            disabled={isDisabled}
            aria-pressed={active}
            onClick={() => {
              if (!active && !isDisabled) onChange(option.value)
            }}
            className={cn(
              'relative inline-flex items-center justify-center whitespace-nowrap rounded-[6px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
              size === 'xs'
                ? 'h-[22px] px-2 text-[12px]'
                : size === 'sm'
                  ? 'h-[26px] px-2.5 text-xs'
                  : 'h-8 px-3 text-sm',
              active ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}
                className="absolute inset-0 z-0 rounded-[6px] border border-accent-border/45 bg-accent-soft shadow-2xs"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {option.icon}
              <span>{option.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
