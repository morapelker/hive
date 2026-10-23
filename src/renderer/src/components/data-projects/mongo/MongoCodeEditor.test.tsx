// The compact Mongo editor mounts a real CodeMirror view in jsdom: the root carries
// data-db-editor (keyboard exemption), the controlled value syncs in without echoing onChange,
// user edits call onChange, Enter submits in submitOnEnter mode and Mod-Enter always does.
import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoCodeEditor, type MongoCodeEditorHandle } from './MongoCodeEditor'

// The shared test setup runs animation frames synchronously, which CodeMirror's measure cycle
// does not expect while the view is still being constructed: run them on a timer instead.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MongoCodeEditor', () => {
  it('syncs the controlled value and reports edits', () => {
    const onChange = vi.fn()
    const ref = createRef<MongoCodeEditorHandle>()
    const { container, rerender } = render(
      <MongoCodeEditor ref={ref} value="{ a: 1 }" onChange={onChange} data-testid="ed" />
    )
    const root = container.querySelector('[data-testid="ed"]')!
    expect(root.hasAttribute('data-db-editor')).toBe(true)
    expect(root.querySelector('.cm-editor')).not.toBeNull()
    const view = ref.current!.getView()!
    expect(view.state.doc.toString()).toBe('{ a: 1 }')

    rerender(<MongoCodeEditor ref={ref} value="{ a: 2 }" onChange={onChange} data-testid="ed" />)
    expect(view.state.doc.toString()).toBe('{ a: 2 }')
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' ' } })
    })
    expect(onChange).toHaveBeenCalledWith('{ a: 2 } ')
  })

  it('submits on Enter (submitOnEnter) and on Mod-Enter', () => {
    const onSubmit = vi.fn()
    const ref = createRef<MongoCodeEditorHandle>()
    render(
      <MongoCodeEditor
        ref={ref}
        value="{}"
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitOnEnter
      />
    )
    const content = ref.current!.getView()!.contentDOM
    act(() => {
      content.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    act(() => {
      content.dispatchEvent(
        // jsdom is not a Mac: CodeMirror's Mod is Ctrl there.
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('places the cursor when focused with an offset', () => {
    const ref = createRef<MongoCodeEditorHandle>()
    render(<MongoCodeEditor ref={ref} value="{ a:  }" onChange={() => undefined} />)
    act(() => ref.current!.focus(5))
    expect(ref.current!.getView()!.state.selection.main.head).toBe(5)
  })
})
