import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GitInitDialog } from '../../../src/renderer/src/components/projects/GitInitDialog'

describe('Session 8: Git Init Dialog', () => {
  describe('GitInitDialog', () => {
    test('renders dialog with title and path when open', () => {
      render(
        <GitInitDialog open={true} path="/tmp/my-project" onCancel={vi.fn()} onConfirm={vi.fn()} />
      )
      expect(screen.getByText('Not a Git Repository')).toBeInTheDocument()
      expect(screen.getByText('/tmp/my-project')).toBeInTheDocument()
      expect(
        screen.getByText('Would you like to initialize a new Git repository?')
      ).toBeInTheDocument()
    })

    test('Cancel button calls onCancel', async () => {
      const onCancel = vi.fn()
      render(<GitInitDialog open={true} path="/tmp/test" onCancel={onCancel} onConfirm={vi.fn()} />)
      await userEvent.click(screen.getByText('Cancel'))
      expect(onCancel).toHaveBeenCalled()
    })

    test('Initialize button calls onConfirm', async () => {
      const onConfirm = vi.fn()
      render(
        <GitInitDialog open={true} path="/tmp/test" onCancel={vi.fn()} onConfirm={onConfirm} />
      )
      await userEvent.click(screen.getByText('Initialize Repository'))
      expect(onConfirm).toHaveBeenCalled()
    })

    test('dialog not rendered when closed', () => {
      render(<GitInitDialog open={false} path="/tmp/test" onCancel={vi.fn()} onConfirm={vi.fn()} />)
      expect(screen.queryByText('Not a Git Repository')).not.toBeInTheDocument()
    })

    test('shows the description text about non-git folder', () => {
      render(
        <GitInitDialog
          open={true}
          path="/Users/test/my-app"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
      expect(screen.getByText('The selected folder is not a Git repository:')).toBeInTheDocument()
    })
  })

  describe('AddProjectButton integration', () => {
    let mockOpenDirectoryDialog: ReturnType<typeof vi.fn>
    let _mockInitRepository: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockOpenDirectoryDialog = vi.fn()
      _mockInitRepository = vi.fn()

      // Mock window.projectOps
      Object.defineProperty(window, 'projectOps', {
        writable: true,
        value: {
          openDirectoryDialog: mockOpenDirectoryDialog,
          initRepository: _mockInitRepository,
          copyToClipboard: vi.fn(),
          showInFolder: vi.fn(),
          validateProject: vi.fn(),
          isGitRepository: vi.fn(),
          openPath: vi.fn(),
          readFromClipboard: vi.fn(),
          detectLanguage: vi.fn(),
          loadLanguageIcons: vi.fn()
        }
      })
    })

    test('shows dialog when adding non-git directory', async () => {
      // Dynamically import to get fresh module
      const { AddProjectButton } =
        await import('../../../src/renderer/src/components/projects/AddProjectButton')
      const { useProjectStore } = await import('../../../src/renderer/src/stores/useProjectStore')

      // Mock store
      const originalState = useProjectStore.getState()
      useProjectStore.setState({
        ...originalState,
        addProject: vi.fn().mockResolvedValue({
          success: false,
          error:
            'The selected folder is not a Git repository. Please select a folder containing a .git directory.'
        })
      })

      mockOpenDirectoryDialog.mockResolvedValue('/tmp/non-git-dir')

      render(<AddProjectButton />)
      await userEvent.click(screen.getByTestId('add-project-button'))

      // Wait for dialog to appear
      expect(await screen.findByText('Not a Git Repository')).toBeInTheDocument()
      expect(screen.getByText('/tmp/non-git-dir')).toBeInTheDocument()
    })

    test('does not show dialog for other errors', async () => {
      const { AddProjectButton } =
        await import('../../../src/renderer/src/components/projects/AddProjectButton')
      const { useProjectStore } = await import('../../../src/renderer/src/stores/useProjectStore')

      useProjectStore.setState({
        ...useProjectStore.getState(),
        addProject: vi.fn().mockResolvedValue({
          success: false,
          error: 'This project has already been added to Hive.'
        })
      })

      mockOpenDirectoryDialog.mockResolvedValue('/tmp/duplicate-project')

      render(<AddProjectButton />)
      await userEvent.click(screen.getByTestId('add-project-button'))

      // Dialog should NOT appear for non-git errors
      expect(screen.queryByText('Not a Git Repository')).not.toBeInTheDocument()
    })
  })
})
