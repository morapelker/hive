import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'
import { GitCommitForm } from '../../../src/renderer/src/components/git/GitCommitForm'

beforeEach(() => {
  vi.clearAllMocks()

  // gitOps is already mocked by test/setup.ts — no need to redefine

  // Reset stores
  useGitStore.setState({
    fileStatusesByWorktree: new Map([
      ['/test/worktree', [{ path: 'file.ts', relativePath: 'file.ts', status: 'M', staged: true }]]
    ]),
    branchInfoByWorktree: new Map(),
    isCommitting: false
  })
})

function setupWorktreeStore(sessionTitles: string): void {
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        'project-1',
        [
          {
            id: 'wt-1',
            project_id: 'project-1',
            name: 'tokyo',
            branch_name: 'tokyo',
            path: '/test/worktree',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: sessionTitles,
            created_at: '2025-01-01T00:00:00Z',
            last_accessed_at: '2025-01-01T00:00:00Z'
          }
        ]
      ]
    ])
  })
}

describe('Session 11: Default Commit Message Frontend', () => {
  describe('session titles parsing', () => {
    test('parses valid JSON session_titles', () => {
      const raw = '["Add feature", "Fix bug"]'
      const parsed = JSON.parse(raw)
      expect(parsed).toEqual(['Add feature', 'Fix bug'])
    })

    test('parses empty JSON array', () => {
      const raw = '[]'
      const parsed = JSON.parse(raw)
      expect(parsed).toEqual([])
    })

    test('handles malformed JSON gracefully', () => {
      const raw = 'not-json'
      let result: string[] = []
      try {
        result = JSON.parse(raw)
      } catch {
        result = []
      }
      expect(result).toEqual([])
    })
  })

  describe('pre-population logic', () => {
    test('single title sets summary only', () => {
      const titles = ['Add dark mode']
      const summary = titles[0]
      const description = titles.length > 1 ? titles.map((t) => `- ${t}`).join('\n') : ''

      expect(summary).toBe('Add dark mode')
      expect(description).toBe('')
    })

    test('multiple titles set summary and bullet description', () => {
      const titles = ['Add dark mode', 'Fix navigation bug', 'Update tests']
      const summary = titles[0]
      const description = titles.length > 1 ? titles.map((t) => `- ${t}`).join('\n') : ''

      expect(summary).toBe('Add dark mode')
      expect(description).toBe('- Add dark mode\n- Fix navigation bug\n- Update tests')
    })

    test('empty titles leave fields empty', () => {
      const titles: string[] = []
      const shouldPopulate = titles.length > 0

      expect(shouldPopulate).toBe(false)
    })
  })

  describe('GitCommitForm rendering with session titles', () => {
    test('summary pre-populates with first session title', () => {
      setupWorktreeStore('["Add feature", "Fix bug"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const summaryInput = screen.getByTestId('commit-summary-input') as HTMLInputElement
      expect(summaryInput.value).toBe('Add feature')
    })

    test('description pre-populates with bullet list of all titles', () => {
      setupWorktreeStore('["Add feature", "Fix bug"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const descInput = screen.getByTestId('commit-description-input') as HTMLTextAreaElement
      expect(descInput.value).toBe('- Add feature\n- Fix bug')
    })

    test('single title sets summary only, leaves description empty', () => {
      setupWorktreeStore('["Add feature"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const summaryInput = screen.getByTestId('commit-summary-input') as HTMLInputElement
      const descInput = screen.getByTestId('commit-description-input') as HTMLTextAreaElement

      expect(summaryInput.value).toBe('Add feature')
      expect(descInput.value).toBe('')
    })

    test('empty session_titles leaves form empty', () => {
      setupWorktreeStore('[]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const summaryInput = screen.getByTestId('commit-summary-input') as HTMLInputElement
      const descInput = screen.getByTestId('commit-description-input') as HTMLTextAreaElement

      expect(summaryInput.value).toBe('')
      expect(descInput.value).toBe('')
    })

    test('malformed session_titles JSON leaves form empty', () => {
      setupWorktreeStore('not-valid-json')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const summaryInput = screen.getByTestId('commit-summary-input') as HTMLInputElement
      expect(summaryInput.value).toBe('')
    })

    test('character counter reflects pre-populated summary length', () => {
      setupWorktreeStore('["Add feature"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const charCount = screen.getByTestId('commit-char-count')
      // "Add feature" is 11 chars
      expect(charCount.textContent).toBe('11/72')
    })

    test('user can edit pre-populated summary', async () => {
      setupWorktreeStore('["Add feature"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const summaryInput = screen.getByTestId('commit-summary-input') as HTMLInputElement
      expect(summaryInput.value).toBe('Add feature')

      await userEvent.clear(summaryInput)
      await userEvent.type(summaryInput, 'My custom message')

      expect(summaryInput.value).toBe('My custom message')
    })

    test('user can edit pre-populated description', async () => {
      setupWorktreeStore('["Add feature", "Fix bug"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const descInput = screen.getByTestId('commit-description-input') as HTMLTextAreaElement
      expect(descInput.value).toBe('- Add feature\n- Fix bug')

      await userEvent.clear(descInput)
      await userEvent.type(descInput, 'Custom description')

      expect(descInput.value).toBe('Custom description')
    })

    test('no worktree path returns null', () => {
      setupWorktreeStore('["Add feature"]')

      const { container } = render(<GitCommitForm worktreePath={null} />)
      expect(container.innerHTML).toBe('')
    })

    test('commit button is enabled when summary is pre-populated and files staged', () => {
      setupWorktreeStore('["Add feature"]')

      render(<GitCommitForm worktreePath="/test/worktree" />)

      const commitButton = screen.getByTestId('commit-button')
      expect(commitButton).not.toBeDisabled()
    })
  })
})
