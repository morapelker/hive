import '@testing-library/jest-dom'
import { vi } from 'vitest'

if (typeof window !== 'undefined') {
  // Mock matchMedia for theme detection
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  // Mock gitOps for components that use GitStatusPanel
  const mockGitOps = {
    getFileStatuses: vi.fn().mockResolvedValue({ success: true, files: [] }),
    getBranchInfo: vi.fn().mockResolvedValue({
      success: true,
      branch: { name: 'main', tracking: null, ahead: 0, behind: 0 }
    }),
    stageFile: vi.fn().mockResolvedValue({ success: true }),
    unstageFile: vi.fn().mockResolvedValue({ success: true }),
    stageAll: vi.fn().mockResolvedValue({ success: true }),
    unstageAll: vi.fn().mockResolvedValue({ success: true }),
    discardChanges: vi.fn().mockResolvedValue({ success: true }),
    addToGitignore: vi.fn().mockResolvedValue({ success: true }),
    commit: vi.fn().mockResolvedValue({ success: true, commitHash: 'abc1234' }),
    push: vi.fn().mockResolvedValue({ success: true }),
    pull: vi.fn().mockResolvedValue({ success: true }),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    showInFinder: vi.fn().mockResolvedValue({ success: true }),
    onStatusChanged: vi.fn().mockReturnValue(() => {}),
    watchBranch: vi.fn().mockResolvedValue({ success: true }),
    unwatchBranch: vi.fn().mockResolvedValue({ success: true }),
    onBranchChanged: vi.fn().mockReturnValue(() => {}),
    getFileContent: vi.fn().mockResolvedValue({ success: true, content: '' }),
    getRemoteUrl: vi.fn().mockResolvedValue({ success: true, url: null, remote: null })
  }

  // Mock fileTreeOps
  const mockFileTreeOps = {
    scan: vi.fn().mockResolvedValue({ success: true, tree: [] }),
    loadChildren: vi.fn().mockResolvedValue({ success: true, children: [] }),
    watch: vi.fn().mockResolvedValue({ success: true }),
    unwatch: vi.fn().mockResolvedValue({ success: true }),
    onChange: vi.fn().mockReturnValue(() => {})
  }

  // Set up window mocks if they don't exist
  if (!window.gitOps) {
    Object.defineProperty(window, 'gitOps', {
      writable: true,
      configurable: true,
      value: mockGitOps
    })
  }

  if (!window.fileTreeOps) {
    Object.defineProperty(window, 'fileTreeOps', {
      writable: true,
      value: mockFileTreeOps
    })
  }

  // Mock systemOps for components that use system operations
  if (!window.systemOps) {
    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        getLogDir: vi.fn().mockResolvedValue('/tmp/logs'),
        getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
        getAppPaths: vi.fn().mockResolvedValue({ userData: '/tmp', home: '/tmp', logs: '/tmp' }),
        isLogMode: vi.fn().mockResolvedValue(false),
        detectAgentSdks: vi.fn().mockResolvedValue({ opencode: true, claude: true }),
        quitApp: vi.fn().mockResolvedValue(undefined),
        openInApp: vi.fn().mockResolvedValue({ success: true }),
        openInChrome: vi.fn().mockResolvedValue({ success: true }),
        onNewSessionShortcut: vi.fn().mockReturnValue(() => {}),
        onCloseSessionShortcut: vi.fn().mockReturnValue(() => {}),
        onFileSearchShortcut: vi.fn().mockReturnValue(() => {}),
        onNotificationNavigate: vi.fn().mockReturnValue(() => {}),
        onWindowFocused: vi.fn().mockReturnValue(() => {}),
        updateMenuState: vi.fn().mockResolvedValue(undefined)
      }
    })
  }
}
