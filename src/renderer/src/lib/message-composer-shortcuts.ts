interface NativeKeyboardLikeEvent {
  isComposing?: boolean
  keyCode?: number
}

export function isComposingKeyboardEvent(
  nativeEvent: NativeKeyboardLikeEvent | undefined,
  fallbackComposing = false
): boolean {
  if (!nativeEvent) return fallbackComposing
  return !!nativeEvent.isComposing || fallbackComposing || nativeEvent.keyCode === 229
}
