import { Select as BaseSelect } from '@base-ui/react/select'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './select'

export interface SelectOption<Value extends string> {
  value: Value
  label: string
  disabled?: boolean
}

interface Props<Value extends string> {
  label: string
  value: Value | ''
  options: readonly SelectOption<Value>[]
  onChange: (value: Value) => void
  placeholder?: string
  leading?: ReactNode
  trailing?: ReactNode
  variant?: 'default' | 'ghost'
  className?: string
  side?: 'top' | 'bottom'
  disabled?: boolean
  required?: boolean
}

export function AirSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  leading,
  trailing = <ChevronDown className="size-3.5" />,
  variant = 'default',
  className,
  side = 'bottom',
  disabled,
  required,
}: Props<Value>) {
  const items = options.map(option => ({ value: option.value, label: option.label }))
  const current = value || null

  return (
    <Select
      items={items}
      value={current}
      disabled={disabled}
      required={required}
      modal={false}
      onValueChange={next => {
        if (typeof next !== 'string') return
        const option = options.find(item => item.value === next)
        if (option && !option.disabled) onChange(option.value)
      }}
    >
      <SelectTrigger
        aria-label={label}
        showIcon={false}
        className={cn(
          'justify-between gap-2 font-normal',
          variant === 'ghost'
            ? 'h-7.5 w-auto border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:border-transparent hover:bg-muted/75 hover:text-foreground data-popup-open:border-transparent data-popup-open:bg-muted data-popup-open:text-foreground'
            : 'w-full',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {leading && <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-3.5">{leading}</span>}
          <SelectValue placeholder={placeholder ?? '请选择'} className="truncate data-placeholder:text-muted-foreground/70" />
        </span>
        {trailing && (
          <BaseSelect.Icon className="flex shrink-0 items-center text-muted-foreground transition-transform duration-150 data-popup-open:rotate-180 [&_svg]:size-3.5">
            {trailing}
          </BaseSelect.Icon>
        )}
      </SelectTrigger>
      <SelectContent side={side} align="start">
        {options.length > 0 ? (
          <SelectGroup>
            {options.map(option => (
              <SelectItem key={option.value} value={option.value} disabled={option.disabled} label={option.label}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : (
          <div className="px-2.5 py-2 text-center text-xs text-muted-foreground">暂无可选项</div>
        )}
      </SelectContent>
    </Select>
  )
}
