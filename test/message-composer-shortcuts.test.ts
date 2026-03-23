import { describe, expect, it } from 'vitest'
import { isComposingKeyboardEvent } from '../src/renderer/src/lib/message-composer-shortcuts'

describe('isComposingKeyboardEvent', () => {
  it('returns the fallback when nativeEvent is undefined and fallback is false', () => {
    expect(isComposingKeyboardEvent(undefined, false)).toBe(false)
  })

  it('returns the fallback when nativeEvent is undefined and fallback is true', () => {
    expect(isComposingKeyboardEvent(undefined, true)).toBe(true)
  })

  it('returns false when no composition signals are present', () => {
    expect(isComposingKeyboardEvent({ isComposing: false, keyCode: 13 }, false)).toBe(false)
  })

  it('returns true when native isComposing is true', () => {
    expect(isComposingKeyboardEvent({ isComposing: true, keyCode: 13 }, false)).toBe(true)
  })

  it('returns true when the local composition fallback ref is true', () => {
    expect(isComposingKeyboardEvent({ isComposing: false, keyCode: 13 }, true)).toBe(true)
  })

  it('returns true for IME fallback keyCode 229', () => {
    expect(isComposingKeyboardEvent({ isComposing: false, keyCode: 229 }, false)).toBe(true)
  })
})
