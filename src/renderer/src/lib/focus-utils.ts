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
 * True when focus is inside a TipTap markdown composer (the ProseMirror
 * contenteditable carries the `tiptap-message-input` class). Used to let the
 * rich editor own keys it handles itself — Tab/Shift+Tab indentation, etc. —
 * so app-wide capture-phase shortcut handlers (build/plan mode toggle) don't
 * steal them. Plain inputs/textareas are intentionally excluded: there Tab
 * should still toggle mode, matching the legacy composer behavior.
 */
export function isFocusedInRichTextEditor(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.closest('.tiptap-message-input') !== null
}
