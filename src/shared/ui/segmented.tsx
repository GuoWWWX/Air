import { motion, useReducedMotion } from 'motion/react'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
  layoutId?: string
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
  ariaLabel,
  disabled,
  size = 'sm',
  fullWidth = false,
  className,
}: SegmentedProps<Value>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const mountedRef = useRef(false)
  const reducedMotion = useReducedMotion()
  const [thumb, setThumb] = useState<{ left: number; width: number; animate: boolean } | null>(null)

  const measure = useCallback(
    (shouldAnimate: boolean) => {
      const btn = buttonRefs.current.get(value)
      if (!btn || btn.offsetWidth <= 0) return
      const left = btn.offsetLeft
      const width = btn.offsetWidth
      const animate = shouldAnimate && mountedRef.current
      mountedRef.current = true
      setThumb(prev => (prev && prev.left === left && prev.width === width ? prev : { left, width, animate }))
    },
    [value],
  )

  useLayoutEffect(() => {
    measure(true)
  }, [measure, options.length, size, fullWidth])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => measure(false))
    observer.observe(container)
    const activeButton = buttonRefs.current.get(value)
    if (activeButton) observer.observe(activeButton)
    return () => observer.disconnect()
  }, [measure, value])

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex items-center gap-0.5 rounded-[8px] border border-border bg-muted/75 p-0.5 select-none dark:bg-input-bg/90',
        fullWidth && 'grid w-full',
        className,
      )}
      style={fullWidth ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {thumb && (
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ x: thumb.left, width: thumb.width }}
          transition={
            !thumb.animate || reducedMotion
              ? { duration: 0 }
              : { type: 'spring', stiffness: 380, damping: 30, mass: 0.75 }
          }
          style={{ willChange: 'transform, width' }}
          className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 z-0 rounded-[6px] border border-accent-border/55 bg-card shadow-2xs dark:border-primary/40 dark:bg-primary/18"
        />
      )}
      {options.map(option => {
        const active = value === option.value
        const isDisabled = Boolean(disabled || option.disabled)
        return (
          <button
            key={option.value}
            ref={node => {
              if (node) buttonRefs.current.set(option.value, node)
              else buttonRefs.current.delete(option.value)
            }}
            type="button"
            disabled={isDisabled}
            aria-pressed={active}
            onClick={() => {
              if (!active && !isDisabled) onChange(option.value)
            }}
            className={cn(
              'relative z-10 inline-flex min-w-0 items-center justify-center whitespace-nowrap rounded-[6px] font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
              size === 'xs'
                ? 'h-[22px] px-2 text-[12px]'
                : size === 'sm'
                  ? 'h-[26px] px-2.5 text-xs'
                  : 'h-8 px-3 text-sm',
              active ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="relative z-10 inline-flex min-w-0 max-w-full items-center gap-1.5">
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
