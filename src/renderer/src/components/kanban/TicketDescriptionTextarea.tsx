import * as React from 'react'
import type { TicketAutocompleteSuggestion } from '@shared/ticket-autocomplete/model'
import { ticketAutocompleteApi } from '@/api/ticket-autocomplete-api'
import { Textarea } from '@/components/ui/textarea'
import {
  INLINE_SUGGESTION_ATTRIBUTE,
  firstWordOf,
  insertTextAtCaret,
  remainingSuggestion
} from '@/lib/inline-suggestion'
import { isMac } from '@/lib/platform'
import { useSettingsStore } from '@/stores/useSettingsStore'

type TicketDescriptionTextareaProps = Omit<React.ComponentProps<typeof Textarea>, 'value'> & {
  value: string
  /** Suggestion source; defaults to the local model in the backend. */
  suggest?: (before: string) => Promise<TicketAutocompleteSuggestion | null>
}

/** Wait for a short pause in typing before asking for a suggestion. */
const SUGGEST_DEBOUNCE_MS = 60

/** Computed styles copied onto the overlay so its text wraps exactly like the textarea's. */
const MIRRORED_STYLES = [
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariantLigatures',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'wordSpacing',
  'wordBreak',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth'
] as const

/**
 * The ticket description textarea with inline completions learned from the
 * user's past tickets. The suggestion is drawn as grey text in an overlay that
 * mirrors the textarea's layout; Tab accepts all of it, Shift+Tab (or
 * Cmd/Ctrl+Right) accepts its next word and keeps the rest showing, Esc
 * dismisses it. Only shown with the caret at the end of a line.
 * With no suggestion showing, plain Tab is swallowed rather than moving focus:
 * it was most likely meant to accept one.
 */
export const TicketDescriptionTextarea = React.forwardRef<
  HTMLTextAreaElement,
  TicketDescriptionTextareaProps
>(function TicketDescriptionTextarea(
  { value, suggest = ticketAutocompleteApi.suggest, onSelect, onFocus, onBlur, onScroll, ...props },
  forwardedRef
) {
  const enabled = useSettingsStore((state) => state.ticketAutocompleteEnabled)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = React.useRef<HTMLDivElement | null>(null)
  const setTextareaRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef]
  )

  // Caret offset while focused with a collapsed selection, otherwise null.
  const [caret, setCaret] = React.useState<number | null>(null)
  const [suggestion, setSuggestion] = React.useState<{ anchor: string; text: string } | null>(null)
  // Text before the caret when the user pressed Esc: don't re-suggest there.
  const [dismissedAt, setDismissedAt] = React.useState<string | null>(null)

  const readCaret = React.useCallback(() => {
    const el = textareaRef.current
    if (!el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) {
      setCaret(null)
      return
    }
    setCaret(el.selectionStart)
  }, [])

  // A controlled value change (typing, accepting) moves the caret too.
  React.useLayoutEffect(readCaret, [value, readCaret])

  const atLineEnd = caret !== null && (caret === value.length || value[caret] === '\n')
  const before = caret !== null ? value.slice(0, caret) : ''
  const after = caret !== null ? value.slice(caret) : ''
  const ghost =
    enabled && atLineEnd && suggestion
      ? remainingSuggestion(suggestion.anchor, suggestion.text, before)
      : ''

  // Ask for a new suggestion when the current one no longer applies.
  React.useEffect(() => {
    if (!enabled || !atLineEnd || ghost || before.length === 0 || dismissedAt === before) return
    let cancelled = false
    const timer = setTimeout(() => {
      suggest(before)
        .then((result) => {
          if (cancelled) return
          setSuggestion(result?.text ? { anchor: before, text: result.text } : null)
        })
        .catch(() => {
          // Autocomplete is best-effort; typing must never be disturbed by it.
        })
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, atLineEnd, ghost, before, dismissedAt, suggest])

  // Accept / dismiss keys. Window capture runs before the app's global Tab
  // handlers and Radix's Escape handler, which would otherwise toggle
  // Build/Plan or Super mode, move focus or close the dialog. Plain Tab is
  // taken even with nothing to accept: a Tab in a field that completes on Tab
  // is far more likely a missed suggestion than a wish to leave the field.
  // Shift+Tab is only taken while a suggestion is showing.
  React.useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent): void => {
      const el = textareaRef.current
      if (!el || e.target !== el || e.isComposing) return
      const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      const shiftOnly = e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      const wordModifier = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (e.key === 'Tab' && plain) {
        if (ghost) insertTextAtCaret(el, ghost)
      } else if (!ghost) {
        return
      } else if (
        (e.key === 'Tab' && shiftOnly) ||
        (e.key === 'ArrowRight' && wordModifier && !e.shiftKey && !e.altKey)
      ) {
        // One word per press so a run of them takes as much as wanted; the
        // rest stays showing since the ghost is what is left of the anchored
        // suggestion after the caret moves.
        insertTextAtCaret(el, firstWordOf(ghost))
      } else if (e.key === 'Escape' && plain) {
        setDismissedAt(before)
        setSuggestion(null)
      } else {
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [enabled, ghost, before])

  // Keep the overlay's box and scroll position identical to the textarea's.
  const syncOverlay = React.useCallback(() => {
    const el = textareaRef.current
    const overlay = overlayRef.current
    if (!el || !overlay) return
    const computed = window.getComputedStyle(el)
    for (const key of MIRRORED_STYLES) overlay.style[key] = computed[key]
    const borders = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth)
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - (borders || 0))
    overlay.style.paddingRight = `calc(${computed.paddingRight} + ${scrollbar}px)`
    overlay.style.width = `${el.offsetWidth}px`
    overlay.style.height = `${el.offsetHeight}px`
    overlay.scrollTop = el.scrollTop
  }, [])

  React.useLayoutEffect(() => {
    if (!ghost) return
    syncOverlay()
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncOverlay)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ghost, value, syncOverlay])

  return (
    <div className="relative w-full">
      <Textarea
        {...props}
        ref={setTextareaRef}
        value={value}
        {...{ [INLINE_SUGGESTION_ATTRIBUTE]: !enabled ? undefined : ghost ? 'active' : 'idle' }}
        onSelect={(e) => {
          readCaret()
          onSelect?.(e)
        }}
        onFocus={(e) => {
          readCaret()
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setCaret(null)
          onBlur?.(e)
        }}
        onScroll={(e) => {
          if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop
          onScroll?.(e)
        }}
      />
      {ghost && (
        <div
          ref={overlayRef}
          aria-hidden
          data-testid="ticket-description-suggestion"
          className="pointer-events-none absolute left-0 top-0 select-none overflow-hidden whitespace-pre-wrap break-words border-solid border-transparent text-transparent"
        >
          {before}
          <span className="text-muted-foreground/70">{ghost}</span>
          {/* The text after the caret keeps the overlay as tall as the textarea so
              it can scroll as far; without it the ghost sinks to the bottom row
              whenever the textarea is scrolled. A trailing newline needs a
              zero-width space after it to make a row, as it does in the textarea. */}
          {after}
          {(after || ghost).endsWith('\n') ? '\u200b' : null}
        </div>
      )}
    </div>
  )
})
