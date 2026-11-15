/**
 * "Pin to board" on a project's own board: the button at the right end of the board's top row
 * (BoardTopRow). It says whether the project is on the Pinned Board and puts it there or takes
 * it off, with the same action as the project's right-click menu (lib/project-pin): same toast,
 * and the user stays on the board they are looking at.
 *
 * Which boards have it is board-pin-project's to say.
 *
 * Its state is read from the pin store, so a pin made anywhere else (the sidebar menu, a
 * worktree's own Pin) shows here at once.
 */
import { Pin } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { setProjectPinned, useIsProjectPinned, type PinnableProject } from '@/lib/project-pin'
import { cn } from '@/lib/utils'
import { usePinnedStore } from '@/stores/usePinnedStore'

const TOOLTIP_DELAY_MS = 300

interface BoardPinButtonProps {
  project: PinnableProject
  className?: string
}

export function BoardPinButton({ project, className }: BoardPinButtonProps) {
  const pinned = useIsProjectPinned(project.id)
  // Until the pins are read the button cannot say which of the two it is: it keeps its place
  // in the row, unseen and out of reach, instead of offering the wrong one.
  const pinsLoaded = usePinnedStore((state) => state.loaded)
  const action = pinned ? 'Unpin from board' : 'Pin to board'
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="board-pin-button"
          data-pinned={pinned ? 'true' : 'false'}
          // The name carries what shows ("Pinned") and what a click does.
          aria-label={pinned ? `Pinned · ${action}` : action}
          disabled={!pinsLoaded}
          onClick={() => void setProjectPinned(project, !pinned)}
          className={cn(
            'flex h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:pointer-events-none',
            pinned
              ? 'border-muted-foreground/35 bg-secondary/60 text-foreground hover:bg-secondary'
              : 'border-border text-muted-foreground hover:border-muted-foreground/35 hover:bg-secondary/40 hover:text-foreground',
            !pinsLoaded && 'invisible',
            className
          )}
        >
          <Pin
            data-testid="board-pin-icon"
            className={cn('h-3.5 w-3.5 shrink-0', pinned && 'fill-current')}
          />
          <span
            data-testid="board-pin-label"
            className="@max-[260px]/board:hidden"
          >
            {pinned ? 'Pinned' : 'Pin to board'}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {action}
      </TooltipContent>
    </Tooltip>
  )
}
