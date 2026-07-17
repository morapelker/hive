import * as React from 'react'
import { HoverCard as HoverCardPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { GhosttySuppressionBoundary } from './GhosttySuppressionBoundary'

function HoverCard({
  openDelay = 150,
  closeDelay = 250,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  )
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <GhosttySuppressionBoundary scope="hover-card">
        <HoverCardPrimitive.Content
          data-slot="hover-card-content"
          align={align}
          sideOffset={sideOffset}
          className={cn(
            'relative overflow-hidden z-50 w-72 origin-(--radix-hover-card-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-lg/5 outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]',
            className
          )}
          {...props}
        />
      </GhosttySuppressionBoundary>
    </HoverCardPrimitive.Portal>
  )
}

function HoverCardArrow({ className, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Arrow>) {
  return (
    <HoverCardPrimitive.Arrow
      data-slot="hover-card-arrow"
      className={cn('bg-popover fill-popover', className)}
      {...props}
    />
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent, HoverCardArrow }
