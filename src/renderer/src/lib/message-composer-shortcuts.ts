interface NativeKeyboardLikeEvent {
  isComposing?: boolean
  keyCode?: number
}

export function isComposingKeyboardEvent(
  nativeEvent: NativeKeyboardLikeEvent | undefined,
  fallbackComposing = false
): boolean {
  if (!nativeEvent) return fallbackComposing

  // Some older browsers still report Enter with keyCode 229 during IME composition.
  return !!nativeEvent.isComposing || fallbackComposing || nativeEvent.keyCode === 229
}
