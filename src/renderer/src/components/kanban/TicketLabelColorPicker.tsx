import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { TICKET_LABEL_COLOR_NAMES, TICKET_LABEL_SWATCH_CLASS } from '@/lib/ticket-label-colors'
import { TICKET_LABEL_COLORS, type TicketLabelColor } from '@shared/lib/ticket-labels'

const SELECTED_RING_CLASS = 'ring-2 ring-ring ring-offset-2 ring-offset-background'

interface TicketLabelColorPickerProps {
  value: TicketLabelColor
  /** The selection moved: arrow keys, Home / End, or a click when there is no `onCommit`. */
  onChange: (color: TicketLabelColor) => void
  /**
   * A swatch was chosen: clicked, or activated with Enter / Space. When given, the arrow keys
   * only browse (`onChange`) and nothing is chosen until then — for a picker whose choice is
   * written at once, such as the Manage dialog's colour popover.
   */
  onCommit?: (color: TicketLabelColor) => void
  /** Names the group for screen readers ("Colour" by default). */
  ariaLabel?: string
  /** Prefix of each swatch's data-testid (`${prefix}-${color}`). */
  testIdPrefix?: string
  disabled?: boolean
  className?: string
}

/**
 * The nine preset colours as a radio group of round swatches. Arrow keys move the selection
 * (and focus) the way a native radio group does, Home / End jump to the ends; only the
 * selected swatch is a tab stop, so Tab leaves the group in one press (and a popover holding
 * the picker opens with focus on the current colour). With `onCommit`, moving the selection
 * is only browsing: a click, Enter or Space on a swatch chooses it.
 */
export function TicketLabelColorPicker({
  value,
  onChange,
  onCommit,
  ariaLabel = 'Colour',
  testIdPrefix = 'ticket-label-color',
  disabled,
  className
}: TicketLabelColorPickerProps) {
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([])

  const select = (index: number): void => {
    const count = TICKET_LABEL_COLORS.length
    const wrapped = ((index % count) + count) % count
    onChange(TICKET_LABEL_COLORS[wrapped])
    swatchRefs.current[wrapped]?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = TICKET_LABEL_COLORS.indexOf(value)
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        select(current + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        select(current - 1)
        break
      case 'Home':
        e.preventDefault()
        select(0)
        break
      case 'End':
        e.preventDefault()
        select(TICKET_LABEL_COLORS.length - 1)
        break
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={disabled ? undefined : handleKeyDown}
      className={cn('flex flex-wrap items-center gap-2.5 p-1', className)}
    >
      {TICKET_LABEL_COLORS.map((color, index) => {
        const selected = color === value
        return (
          <button
            key={color}
            ref={(el) => {
              swatchRefs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={TICKET_LABEL_COLOR_NAMES[color]}
            title={TICKET_LABEL_COLOR_NAMES[color]}
            data-testid={`${testIdPrefix}-${color}`}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            // Enter and Space activate the focused swatch as a click, so they commit too
            onClick={() => (onCommit ? onCommit(color) : onChange(color))}
            className={cn(
              'h-5 w-5 shrink-0 rounded-full outline-none transition-shadow disabled:opacity-50',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              TICKET_LABEL_SWATCH_CLASS[color],
              selected && SELECTED_RING_CLASS
            )}
          />
        )
      })}
    </div>
  )
}
