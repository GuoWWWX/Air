import { Button as BaseButton } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] text-sm font-medium outline-none select-none transition-[background-color,border-color,color,box-shadow,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground border border-primary hover:bg-primary-hover hover:border-primary-hover shadow-xs',
        secondary:
          'bg-secondary text-secondary-foreground border border-border hover:bg-muted/80 hover:border-accent-border shadow-2xs',
        subtle:
          'bg-accent-soft text-primary border border-accent-border/70 hover:bg-accent-soft/80 hover:border-accent-border',
        outline:
          'bg-transparent text-foreground border border-border hover:bg-muted/70 hover:border-accent-border',
        ghost:
          'bg-transparent text-muted-foreground border border-transparent hover:bg-muted/80 hover:text-foreground',
        destructive:
          'bg-danger-soft text-destructive border border-destructive/30 hover:bg-destructive/20 hover:border-destructive/50',
      },
      size: {
        default: 'h-8.5 px-3',
        sm: 'h-7 px-2.5 text-xs rounded-[6px]',
        lg: 'h-9.5 px-4',
        icon: 'size-8.5 p-0',
        'icon-sm': 'size-7 p-0 rounded-[6px]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ComponentProps<typeof BaseButton>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <BaseButton
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { buttonVariants }
