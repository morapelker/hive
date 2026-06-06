export function isEditableElement(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)
  )
}

export function hasFocusedEditableElement(): boolean {
  return isEditableElement(document.activeElement)
}

/**
 * Selector for our TipTap editors' ProseMirror contenteditable roots: the chat
 * composer (`tiptap-message-input`) and the kanban rich-text editor
 * (`tiptap-rich-editor`).
 */
const RICH_TEXT_EDITOR_SELECTOR = '.tiptap-message-input, .tiptap-rich-editor'

/**
 * True when focus is inside one of our TipTap editors. Used to let the rich
 * editor own keys it handles itself — Tab/Shift+Tab indentation, etc. — so
 * app-wide capture-phase shortcut handlers (build/plan mode toggle) don't steal
 * them. Plain inputs/textareas are intentionally excluded: there Tab should
 * still toggle mode, matching the legacy composer behavior.
 */
export function isFocusedInRichTextEditor(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.closest(RICH_TEXT_EDITOR_SELECTOR) !== null
}
