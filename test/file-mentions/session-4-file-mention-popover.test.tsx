import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileMentionPopover } from '../../src/renderer/src/components/sessions/FileMentionPopover'
import type { FlatFile } from '../../src/renderer/src/lib/file-search-utils'

/**
 * Session 4: FileMentionPopover Component
 *
 * Tests the visual popover that renders file suggestions when the user
 * types '@' in the chat input. Follows the same patterns as SlashCommandPopover.
 */

// Mock FileIcon since it depends on file-icons module with SVG assets
vi.mock('../../src/renderer/src/components/file-tree/FileIcon', () => ({
  FileIcon: ({ name }: { name: string }) => <span data-testid="file-icon">{name}</span>
}))

const mockSuggestions: FlatFile[] = [
  {
    name: 'helpers.ts',
    path: '/project/src/utils/helpers.ts',
    relativePath: 'src/utils/helpers.ts',
    extension: '.ts'
  },
  {
    name: 'index.tsx',
    path: '/project/src/index.tsx',
    relativePath: 'src/index.tsx',
    extension: '.tsx'
  },
  {
    name: 'config.json',
    path: '/project/config.json',
    relativePath: 'config.json',
    extension: '.json'
  },
  { name: 'README.md', path: '/project/README.md', relativePath: 'README.md', extension: '.md' },
  {
    name: 'styles.css',
    path: '/project/src/styles.css',
    relativePath: 'src/styles.css',
    extension: '.css'
  }
]

describe('Session 4: FileMentionPopover', () => {
  let onSelect: ReturnType<typeof vi.fn>
  let onClose: ReturnType<typeof vi.fn>
  let onNavigate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSelect = vi.fn()
    onClose = vi.fn()
    onNavigate = vi.fn()
  })

  test('renders null when visible=false', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={false}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    expect(screen.queryByTestId('file-mention-popover')).toBeNull()
  })

  test('renders file suggestions when visible=true', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    expect(screen.getByTestId('file-mention-popover')).toBeTruthy()
    const items = screen.getAllByTestId('file-mention-item')
    expect(items).toHaveLength(5)
  })

  test('shows "No files found" when suggestions is empty', () => {
    render(
      <FileMentionPopover
        suggestions={[]}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    expect(screen.getByText('No files found')).toBeTruthy()
  })

  test('displays filename and relative path for each suggestion', () => {
    render(
      <FileMentionPopover
        suggestions={[mockSuggestions[0]]}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    // filename appears in both the FileIcon mock and the label span
    const nameMatches = screen.getAllByText('helpers.ts')
    expect(nameMatches.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('src/utils/helpers.ts')).toBeTruthy()
  })

  test('highlights the selected item with bg-accent', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={2}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    const items = screen.getAllByTestId('file-mention-item')
    // The third item (index 2) should have bg-accent class
    expect(items[2].className).toContain('bg-accent')
    // Other items should NOT have bg-accent
    expect(items[0].className).not.toContain('bg-accent')
    expect(items[1].className).not.toContain('bg-accent')
  })

  test('calls onSelect when Enter is pressed with correct file', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={1}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(mockSuggestions[1])
  })

  test('calls onClose when Escape is pressed', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  test('calls onNavigate("down") on ArrowDown', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(onNavigate).toHaveBeenCalledWith('down')
  })

  test('calls onNavigate("up") on ArrowUp', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(onNavigate).toHaveBeenCalledWith('up')
  })

  test('calls onSelect when a suggestion is clicked', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    const items = screen.getAllByTestId('file-mention-item')
    fireEvent.click(items[3])
    expect(onSelect).toHaveBeenCalledWith(mockSuggestions[3])
  })

  test('has data-testid="file-mention-popover"', () => {
    render(
      <FileMentionPopover
        suggestions={mockSuggestions}
        selectedIndex={0}
        visible={true}
        onSelect={onSelect}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    )

    expect(screen.getByTestId('file-mention-popover')).toBeTruthy()
  })
})
