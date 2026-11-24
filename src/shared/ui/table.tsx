import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<'table'> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn('air-card-surface air-scroll w-full overflow-auto rounded-[10px] border border-border', containerClassName)}
    >
      <table
        data-slot="table"
        className={cn('w-full border-collapse text-left text-xs whitespace-nowrap', className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('sticky top-0 z-10 bg-muted/85 backdrop-blur-xs [&_tr]:border-b [&_tr]:border-border', className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-border-subtle transition-colors hover:bg-muted/45 data-[selected=true]:bg-primary/[0.10] data-[selected=true]:hover:bg-primary/[0.14] dark:data-[selected=true]:bg-primary/[0.20] dark:data-[selected=true]:hover:bg-primary/[0.25]',
        className,
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-9 px-3 text-left align-middle text-xs font-semibold text-muted-foreground select-none',
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-3 py-2.5 align-middle text-foreground', className)}
      {...props}
    />
  )
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
