import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Checkbox } from './checkbox'

interface Props {
  label: string
  checked: boolean | 'indeterminate'
  onChange: (checked: boolean) => void
  disabled?: boolean
  children?: ReactNode
  className?: string
  checkboxClassName?: string
}

export function AirCheckbox({
  label,
  checked,
  onChange,
  disabled,
  children,
  className,
  checkboxClassName,
}: Props) {
  const isIndeterminate = checked === 'indeterminate'
  return (
    <label
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-2 select-none',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        className,
      )}
    >
      <Checkbox
        aria-label={label}
        checked={checked === true}
        indeterminate={isIndeterminate}
        disabled={disabled}
        onCheckedChange={next => onChange(next)}
        className={checkboxClassName}
      />
      {children}
    </label>
  )
}
