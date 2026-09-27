/**
 * Helpers for inline ("ghost text") suggestions in plain textareas.
 */

/** Set to "active" on a field while it shows a suggestion that Tab would accept. */
export const INLINE_SUGGESTION_ATTRIBUTE = 'data-inline-suggestion'

/**
 * True when a key event is headed for a field that is showing an inline
 * suggestion. Global capture-phase Tab handlers (Build/Plan toggle, the ticket
 * modal's focus guard) must leave such events alone so Tab can accept.
 */
export function isInlineSuggestionTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && target.getAttribute(INLINE_SUGGESTION_ATTRIBUTE) === 'active'
  )
}

/**
 * What is left to show of a suggestion made when the text before the caret
 * was `anchor`, now that it is `before`. Typing through the suggestion keeps
 * the rest visible; anything else invalidates it (empty string).
 */
export function remainingSuggestion(anchor: string, text: string, before: string): string {
  if (!before.startsWith(anchor)) return ''
  const full = anchor + text
  if (!full.startsWith(before)) return ''
  return full.slice(before.length)
}

/** The next word of a suggestion, with its leading whitespace: what Cmd/Ctrl+Right accepts. */
export function firstWordOf(text: string): string {
  return text.match(/^\s*\S+/)?.[0] ?? text
}

/**
 * Insert text at the caret as if the user typed it: goes through the native
 * editing path so React's onChange fires and Cmd+Z undoes it. Falls back to
 * setting the value directly where execCommand is unavailable (jsdom).
 */
export function insertTextAtCaret(el: HTMLTextAreaElement, text: string): void {
  el.focus()
  const inserted =
    typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
  if (inserted) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const next = el.value.slice(0, start) + text + el.value.slice(end)
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, next)
  el.setSelectionRange(start + text.length, start + text.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
