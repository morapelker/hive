// Cell inspector: JSON shows and applies with every number and escape as stored (no parse /
// stringify round trip), Apply stages only a real change, JSON columns refuse non-JSON while
// jsonpath / json[] values are plain text, NULL is explicit.
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'

vi.mock('@/components/ui/dialog', () => {
  type Props = { children?: ReactNode; 'data-testid'?: string }
  const Pass = ({ children }: Props): ReactNode => children
  return {
    Dialog: ({ open, children }: Props & { open: boolean }): ReactNode => (open ? children : null),
    DialogContent: ({ children, 'data-testid': testId }: Props): ReactNode => (
      <div data-testid={testId}>{children}</div>
    ),
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass
  }
})
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { CellInspector } = await import('./CellInspector')

afterEach(cleanup)

const JSON_VALUE = '{"id": 1234567890123456789, "name": "Alice", "ratio": 1.0, "s": "\\u00e9"}'

function open(
  value: DataCell | undefined,
  column: DataColumnMeta,
  onApply?: (value: DataCell) => void
): { onOpenChange: ReturnType<typeof vi.fn> } {
  const onOpenChange = vi.fn()
  render(
    <CellInspector
      open
      onOpenChange={onOpenChange}
      column={column}
      value={value}
      onApply={onApply}
    />
  )
  return { onOpenChange }
}

const editor = (): HTMLTextAreaElement =>
  screen.getByTestId('data-project-cell-inspector-editor') as HTMLTextAreaElement
const apply = (): HTMLButtonElement =>
  screen.getByTestId('data-project-cell-inspector-apply') as HTMLButtonElement

describe('CellInspector', () => {
  it('shows JSON pretty-printed with its numbers and escapes as stored', () => {
    open(JSON_VALUE, { name: 'attrs', type: 'json' })
    const shown = screen.getByTestId('data-project-cell-inspector-value').textContent ?? ''
    expect(shown).toContain('"id": 1234567890123456789,')
    expect(shown).toContain('"ratio": 1.0,')
    expect(shown).toContain('"s": "\\u00e9"')
    fireEvent.click(screen.getByTestId('data-project-cell-inspector-view-text'))
    expect(screen.getByTestId('data-project-cell-inspector-value')).toHaveTextContent(JSON_VALUE)
  })

  it('applies nothing for an untouched value, and only the tokens the user changed', () => {
    const onApply = vi.fn()
    const { onOpenChange } = open(JSON_VALUE, { name: 'attrs', type: 'jsonb' }, onApply)
    expect(editor().value).toContain('"id": 1234567890123456789,')
    fireEvent.click(apply())
    expect(onApply).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    cleanup()

    open(JSON_VALUE, { name: 'attrs', type: 'jsonb' }, onApply)
    fireEvent.change(editor(), { target: { value: editor().value.replace('Alice', 'Alicia') } })
    fireEvent.click(apply())
    expect(onApply).toHaveBeenCalledWith(
      '{"id":1234567890123456789,"name":"Alicia","ratio":1.0,"s":"\\u00e9"}'
    )
  })

  it('refuses non-JSON only in JSON columns: jsonpath and json[] values are text', () => {
    const onApply = vi.fn()
    open('{"a":1}', { name: 'doc', type: 'json' }, onApply)
    fireEvent.change(editor(), { target: { value: '{"a":' } })
    expect(apply()).toBeDisabled()
    expect(screen.getByTestId('data-project-cell-inspector')).toHaveTextContent('Not valid JSON')
    // a JSON scalar is JSON
    fireEvent.change(editor(), { target: { value: '42' } })
    expect(apply()).not.toBeDisabled()
    cleanup()

    open('$.a.b', { name: 'path', type: 'jsonpath' }, onApply)
    fireEvent.change(editor(), { target: { value: '$.a.c' } })
    expect(apply()).not.toBeDisabled()
    fireEvent.click(apply())
    expect(onApply).toHaveBeenLastCalledWith('$.a.c')
    cleanup()

    const array = '{"{\\"a\\": 1}","{\\"b\\": 2}"}'
    open(array, { name: 'docs', type: 'jsonb[]' }, onApply)
    fireEvent.change(editor(), { target: { value: array.replace('2', '3') } })
    expect(apply()).not.toBeDisabled()
    fireEvent.click(apply())
    expect(onApply).toHaveBeenLastCalledWith(array.replace('2', '3'))
  })

  it('sets NULL explicitly and leaves a NULL alone', () => {
    const onApply = vi.fn()
    open('x', { name: 'note', type: 'text' }, onApply)
    fireEvent.click(screen.getByTestId('data-project-cell-inspector-null'))
    fireEvent.click(apply())
    expect(onApply).toHaveBeenLastCalledWith(null)
    cleanup()
    onApply.mockClear()
    open(null, { name: 'note', type: 'text' }, onApply)
    fireEvent.click(apply())
    expect(onApply).not.toHaveBeenCalled()
  })
})
