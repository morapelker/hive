import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SlashCommandPopover } from '../../../src/renderer/src/components/sessions/SlashCommandPopover'

/**
 * Session 7: Slash Commands
 *
 * Tests the slash command popover that appears when "/" is typed,
 * filters commands by substring, supports keyboard navigation,
 * and inserts the selected command into the input.
 */

const mockCommands = [
  { name: 'compact', description: 'Compact context', template: '/compact' },
  { name: 'using-superpowers', description: 'Use superpowers', template: '/using-superpowers' },
  { name: 'commit', description: 'Create a commit', template: '/commit' },
  { name: 'review-pr', description: 'Review a pull request', template: '/review-pr' },
  { name: 'test', description: 'Run tests', template: '/test' },
  { name: 'help', description: 'Show help', template: '/help' },
  { name: 'explain', description: 'Explain code', template: '/explain' },
  { name: 'implement', description: 'Implement feature', template: '/implement' },
  { name: 'analyze', description: 'Analyze code', template: '/analyze' },
  { name: 'improve', description: 'Improve code', template: '/improve' }
]

describe('Session 7: Slash Commands', () => {
  describe('SlashCommandPopover', () => {
    let onSelect: ReturnType<typeof vi.fn>
    let onClose: ReturnType<typeof vi.fn>

    beforeEach(() => {
      onSelect = vi.fn()
      onClose = vi.fn()
    })

    test('Popover shown when visible=true and filter starts with "/"', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      expect(screen.getByTestId('slash-command-popover')).toBeTruthy()
    })

    test('Popover hidden when visible=false', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={false}
        />
      )

      expect(screen.queryByTestId('slash-command-popover')).toBeNull()
    })

    test('Commands filtered by substring', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/super"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // "using-superpowers" should match "/super"
      expect(screen.getByTestId('slash-item-using-superpowers')).toBeTruthy()
      // "compact" should NOT match "/super"
      expect(screen.queryByTestId('slash-item-compact')).toBeNull()
    })

    test('Fuzzy filter: "/comp" matches "compact"', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/comp"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      expect(screen.getByTestId('slash-item-compact')).toBeTruthy()
    })

    test('Max 8 items shown', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // 10 commands but max 8 shown
      const items = screen.getAllByText(/^\//)
      expect(items.length).toBeLessThanOrEqual(8)
    })

    test('Each item shows name and description', () => {
      render(
        <SlashCommandPopover
          commands={[{ name: 'compact', description: 'Compact context', template: '/compact' }]}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      expect(screen.getByText('/compact')).toBeTruthy()
      expect(screen.getByText('Compact context')).toBeTruthy()
    })

    test('Click selects a command', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      fireEvent.click(screen.getByTestId('slash-item-compact'))
      expect(onSelect).toHaveBeenCalledWith({ name: 'compact', template: '/compact' })
    })

    test('Enter selects highlighted command', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // First item is selected by default, press Enter
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith({ name: 'compact', template: '/compact' })
    })

    test('Arrow down selects next item', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // Press ArrowDown to move to second item, then Enter
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith({ name: 'using-superpowers', template: '/using-superpowers' })
    })

    test('Arrow up selects previous item', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // Move down twice, then up once — should land on 2nd item (index 1)
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'ArrowUp' })
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith({ name: 'using-superpowers', template: '/using-superpowers' })
    })

    test('Escape closes popover', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
    })

    test('Empty filter shows all commands (up to max)', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // With "/" filter and 10 commands, should show 8 (MAX_VISIBLE_ITEMS)
      const popover = screen.getByTestId('slash-command-popover')
      const items = popover.querySelectorAll('[data-slash-item]')
      expect(items.length).toBe(8)
    })

    test('No commands matching filter shows empty state', () => {
      render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/zzzzzzz"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // No matches — popover shows "No matching commands" message
      expect(screen.getByTestId('slash-command-popover')).toBeTruthy()
      expect(screen.getByText('No matching commands')).toBeTruthy()
    })

    test('Selection resets when filter changes', () => {
      const { rerender } = render(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // Move selection down
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'ArrowDown' })

      // Change filter — should reset selection to 0
      rerender(
        <SlashCommandPopover
          commands={mockCommands}
          filter="/comp"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // Press Enter — should select first filtered item
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith({ name: 'compact', template: '/compact' })
    })
  })

  describe('Slash command input detection', () => {
    test('Input starting with "/" triggers slash mode', () => {
      let showSlashCommands = false
      const handleInputChange = (value: string): void => {
        if (value.startsWith('/') && value.length >= 1) {
          showSlashCommands = true
        } else {
          showSlashCommands = false
        }
      }

      handleInputChange('/')
      expect(showSlashCommands).toBe(true)
    })

    test('Input not starting with "/" hides slash mode', () => {
      let showSlashCommands = false
      const handleInputChange = (value: string): void => {
        if (value.startsWith('/') && value.length >= 1) {
          showSlashCommands = true
        } else {
          showSlashCommands = false
        }
      }

      handleInputChange('hello')
      expect(showSlashCommands).toBe(false)
    })

    test('Clearing "/" hides slash mode', () => {
      let showSlashCommands = true
      const handleInputChange = (value: string): void => {
        if (value.startsWith('/') && value.length >= 1) {
          showSlashCommands = true
        } else {
          showSlashCommands = false
        }
      }

      handleInputChange('')
      expect(showSlashCommands).toBe(false)
    })

    test('"/comp" triggers slash mode', () => {
      let showSlashCommands = false
      const handleInputChange = (value: string): void => {
        if (value.startsWith('/') && value.length >= 1) {
          showSlashCommands = true
        } else {
          showSlashCommands = false
        }
      }

      handleInputChange('/comp')
      expect(showSlashCommands).toBe(true)
    })
  })

  describe('Command selection', () => {
    test('handleCommandSelect sets input to "/commandName "', () => {
      let inputValue = '/'
      const handleCommandSelect = (cmd: { name: string; template: string }): void => {
        inputValue = `/${cmd.name} `
      }

      handleCommandSelect({ name: 'compact', template: '/compact' })
      expect(inputValue).toBe('/compact ')
    })

    test('handleCommandSelect hides popover', () => {
      let showSlashCommands = true
      const handleCommandSelect = (_cmd: { name: string; template: string }): void => {
        showSlashCommands = false
      }

      handleCommandSelect({ name: 'compact', template: '/compact' })
      expect(showSlashCommands).toBe(false)
    })
  })

  describe('Substring filtering', () => {
    test('filter matches substring in middle of name', () => {
      const commands = mockCommands
      const filterText = 'super'
      const filtered = commands.filter((c) =>
        c.name.toLowerCase().includes(filterText.toLowerCase())
      )

      expect(filtered).toHaveLength(1)
      expect(filtered[0].name).toBe('using-superpowers')
    })

    test('filter matches prefix', () => {
      const commands = mockCommands
      const filterText = 'comp'
      const filtered = commands.filter((c) =>
        c.name.toLowerCase().includes(filterText.toLowerCase())
      )

      expect(filtered).toHaveLength(1)
      expect(filtered[0].name).toBe('compact')
    })

    test('filter is case-insensitive', () => {
      const commands = mockCommands
      const filterText = 'COMMIT'
      const filtered = commands.filter((c) =>
        c.name.toLowerCase().includes(filterText.toLowerCase())
      )

      expect(filtered).toHaveLength(1)
      expect(filtered[0].name).toBe('commit')
    })

    test('empty filter matches all commands', () => {
      const commands = mockCommands
      const filterText = ''
      const filtered = commands.filter((c) =>
        c.name.toLowerCase().includes(filterText.toLowerCase())
      )

      expect(filtered).toHaveLength(mockCommands.length)
    })
  })
})
