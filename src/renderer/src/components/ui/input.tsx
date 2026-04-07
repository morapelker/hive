import * as React from 'react'

import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs/5 transition-[color,box-shadow,border-color] duration-200 ease-in-out file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:border-ring disabled:pointer-events-none disabled:opacity-64 md:text-sm dark:bg-input/32 aria-invalid:border-destructive/36 dark:aria-invalid:ring-destructive/24 relative overflow-hidden before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
