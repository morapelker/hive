import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useVimModeStore } from '@/stores/useVimModeStore'

describe('useVimModeStore', () => {
  beforeEach(() => {
    useVimModeStore.setState({
      mode: 'normal',
      helpOverlayOpen: false
    })
  })

  it('starts in normal mode with helpOverlayOpen false', () => {
    const state = useVimModeStore.getState()
    expect(state.mode).toBe('normal')
    expect(state.helpOverlayOpen).toBe(false)
  })

  it('enterInsertMode sets mode to insert', () => {
    useVimModeStore.getState().enterInsertMode()
    expect(useVimModeStore.getState().mode).toBe('insert')
  })

  it('enterNormalMode sets mode to normal and blurs active element', () => {
    const blurSpy = vi.fn()
    Object.defineProperty(document, 'activeElement', {
      value: { blur: blurSpy },
      configurable: true
    })

    useVimModeStore.getState().enterInsertMode()
    expect(useVimModeStore.getState().mode).toBe('insert')

    useVimModeStore.getState().enterNormalMode()
    expect(useVimModeStore.getState().mode).toBe('normal')
    expect(blurSpy).toHaveBeenCalled()
  })

  it('toggleHelpOverlay toggles helpOverlayOpen', () => {
    expect(useVimModeStore.getState().helpOverlayOpen).toBe(false)
    useVimModeStore.getState().toggleHelpOverlay()
    expect(useVimModeStore.getState().helpOverlayOpen).toBe(true)
    useVimModeStore.getState().toggleHelpOverlay()
    expect(useVimModeStore.getState().helpOverlayOpen).toBe(false)
  })

  it('setHelpOverlayOpen explicitly sets helpOverlayOpen', () => {
    useVimModeStore.getState().setHelpOverlayOpen(true)
    expect(useVimModeStore.getState().helpOverlayOpen).toBe(true)
    useVimModeStore.getState().setHelpOverlayOpen(false)
    expect(useVimModeStore.getState().helpOverlayOpen).toBe(false)
  })
})
