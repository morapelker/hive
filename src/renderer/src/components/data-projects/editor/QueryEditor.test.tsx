// QueryEditor with a real CodeMirror view (jsdom): the root carries data-db-editor, Mod-Enter runs
// the statement under the cursor (or the selection) and Shift-Mod-Enter everything, Mod-. cancels,
// the controlled value syncs in as one change without echoing onChange, typing reports onChange,
// the error range is underlined and dropped when edited, read-only blocks edits, and the
// completion config facet follows the props (dialect, schema index).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { dataEditorConfig } from './context'
import { QueryEditor, type QueryEditorHandle } from './QueryEditor'

afterEach(cleanup)

// test/setup.ts makes requestAnimationFrame synchronous; CodeMirror requests a measure while
// its view is still being constructed, which only works with a real (asynchronous) frame.
const syncRaf = window.requestAnimationFrame
beforeAll(() => {
  window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    window.setTimeout(() => cb(performance.now()), 0)
})
afterAll(() => {
  window.requestAnimationFrame = syncRaf
})

// jsdom's platform is not macOS, so CodeMirror's "Mod" is Ctrl here.
const press = (target: HTMLElement, k: string, mods: { shift?: boolean } = {}): void => {
  fireEvent.keyDown(target, { key: k, ctrlKey: true, shiftKey: !!mods.shift })
}

function setup(props: Partial<React.ComponentProps<typeof QueryEditor>> = {}) {
  const ref = createRef<QueryEditorHandle>()
  const onChange = vi.fn()
  const onRun = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <QueryEditor
      ref={ref}
      value={'SELECT 1;\nSELECT 2 FROM t;'}
      onChange={onChange}
      language="sql"
      dialect="postgres"
      onRun={onRun}
      onCancel={onCancel}
      {...props}
    />
  )
  const view = ref.current?.getView()
  if (!view) throw new Error('no view')
  return { ...utils, ref, view, onChange, onRun, onCancel }
}

describe('QueryEditor', () => {
  it('marks its root for the keyboard exemption', () => {
    setup()
    const root = screen.getByTestId('data-project-query-editor')
    expect(root).toHaveAttribute('data-db-editor')
    expect(root.querySelector('.cm-editor')).toHaveAttribute('data-db-editor')
  })

  it('runs the statement under the cursor, the selection, or everything', () => {
    const { view, onRun, onCancel } = setup()
    act(() => view.dispatch({ selection: { anchor: 14 } }))
    press(view.contentDOM, 'Enter')
    expect(onRun).toHaveBeenLastCalledWith({
      text: 'SELECT 2 FROM t',
      from: 10,
      to: 25,
      mode: 'current'
    })
    act(() => view.dispatch({ selection: { anchor: 0, head: 6 } }))
    press(view.contentDOM, 'Enter')
    expect(onRun).toHaveBeenLastCalledWith({ text: 'SELECT', from: 0, to: 6, mode: 'selection' })
    press(view.contentDOM, 'Enter', { shift: true })
    expect(onRun).toHaveBeenLastCalledWith({
      text: 'SELECT 1;\nSELECT 2 FROM t;',
      from: 0,
      to: 26,
      mode: 'all'
    })
    press(view.contentDOM, '.')
    expect(onCancel).toHaveBeenCalledTimes(1)
    // Mod-Enter must not insert a line
    expect(view.state.doc.lines).toBe(2)
  })

  it('syncs the controlled value without echoing it and reports user edits', () => {
    const { view, rerender, onChange, ref } = setup()
    rerender(
      <QueryEditor
        ref={ref}
        value="SELECT 42"
        onChange={onChange}
        language="sql"
        dialect="postgres"
      />
    )
    expect(view.state.doc.toString()).toBe('SELECT 42')
    expect(onChange).not.toHaveBeenCalled()
    act(() => view.dispatch({ changes: { from: 9, insert: ';' }, userEvent: 'input.type' }))
    expect(onChange).toHaveBeenCalledWith('SELECT 42;')
  })

  it('underlines the error range and drops it when the text there changes', () => {
    const { view, container } = setup({ errorRange: { from: 19, to: 23, message: 'boom' } })
    expect(container.querySelector('.cm-dp-error')?.textContent).toBe('FROM')
    act(() => view.dispatch({ changes: { from: 19, to: 23, insert: 'FRM' } }))
    expect(container.querySelector('.cm-dp-error')).toBeNull()
  })

  it('is read-only on request', () => {
    const { view } = setup({ readOnly: true })
    expect(view.state.readOnly).toBe(true)
  })

  it('exposes setText / insertText / getRunTarget on the handle', () => {
    const { ref, view, onChange } = setup()
    act(() => ref.current?.setText('SELECT 7'))
    expect(view.state.doc.toString()).toBe('SELECT 7')
    expect(onChange).toHaveBeenLastCalledWith('SELECT 7')
    act(() => ref.current?.insertText(' + 1'))
    expect(view.state.doc.toString()).toBe('SELECT 7 + 1')
    expect(ref.current?.getRunTarget('all')).toMatchObject({ text: 'SELECT 7 + 1', mode: 'all' })
  })

  it('reconfigures the completion facet from props', () => {
    const { view, rerender, ref, onChange } = setup()
    expect(view.state.facet(dataEditorConfig)).toMatchObject({
      language: 'sql',
      dialect: 'postgres',
      completionIndex: null
    })
    rerender(
      <QueryEditor
        ref={ref}
        value={'SELECT 1;\nSELECT 2 FROM t;'}
        onChange={onChange}
        language="sql"
        dialect="mysql"
        completionSchema={{
          databases: ['shop'],
          tables: [{ name: 'users', kind: 'table', columns: [] }]
        }}
      />
    )
    const config = view.state.facet(dataEditorConfig)
    expect(config.dialect).toBe('mysql')
    expect(config.completionIndex?.byName.has('users')).toBe(true)
  })
})
