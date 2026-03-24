import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { translate } from '@/i18n/useI18n'

const mockUpdateSetting = vi.fn()
let mockSettingsState: Record<string, unknown> = {}

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      return selector ? selector(mockSettingsState) : mockSettingsState
    },
    {
      getState: () => mockSettingsState
    }
  )
}))

vi.mock('@/stores/useThemeStore', () => ({
  useThemeStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { setTheme: vi.fn(), themeId: 'default' }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({ setTheme: vi.fn(), themeId: 'default' })
    }
  )
}))

vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { resetToDefaults: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({ resetToDefaults: vi.fn() })
    }
  )
}))

vi.mock('@/hooks', () => ({
  useGhosttySuppression: vi.fn()
}))

vi.mock('@/lib/themes', () => ({
  DEFAULT_THEME_ID: 'default',
  THEME_PRESETS: [
    {
      id: 'default-dark',
      name: 'Default Dark',
      type: 'dark',
      colors: {
        background: '#000000',
        sidebar: '#111111',
        primary: '#222222',
        'muted-foreground': '#333333'
      }
    },
    {
      id: 'default-light',
      name: 'Default Light',
      type: 'light',
      colors: {
        background: '#ffffff',
        sidebar: '#eeeeee',
        primary: '#dddddd',
        'muted-foreground': '#cccccc'
      }
    }
  ]
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('Settings i18n', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = {
      locale: 'zh-CN',
      autoStartSession: true,
      breedType: 'dogs',
      vimModeEnabled: false,
      showModelIcons: false,
      showModelProvider: false,
      showUsageIndicator: true,
      defaultAgentSdk: 'opencode',
      updateChannel: 'stable',
      stripAtMentions: true,
      updateSetting: mockUpdateSetting,
      resetToDefaults: vi.fn(),
      isOpen: true,
      activeSection: 'general',
      closeSettings: vi.fn(),
      openSettings: vi.fn(),
      setActiveSection: vi.fn()
    }

    Object.defineProperty(window, 'updaterOps', {
      configurable: true,
      writable: true,
      value: {
        getVersion: vi.fn().mockResolvedValue('1.0.71'),
        checkForUpdate: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  it('renders translated labels in SettingsGeneral when locale is zh-CN', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    expect(screen.getByText('通用')).toBeInTheDocument()
    expect(screen.getByText('语言')).toBeInTheDocument()
    expect(screen.getByText('AI 提供方')).toBeInTheDocument()
    expect(screen.getByText('分支命名')).toBeInTheDocument()
    expect(screen.getByTestId('reset-all-settings')).toHaveTextContent('重置全部设置')
  })

  it('updates locale when the language selector changes', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    await userEvent.selectOptions(screen.getByTestId('settings-language-select'), 'en')

    expect(mockUpdateSetting).toHaveBeenCalledWith('locale', 'en')
  })

  it('renders translated navigation labels in SettingsModal', async () => {
    const { SettingsModal } = await import('@/components/settings/SettingsModal')
    render(<SettingsModal />)

    expect(screen.getByText('设置')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toHaveTextContent('通用')
    expect(screen.getByTestId('settings-nav-appearance')).toHaveTextContent('外观')
    expect(screen.getByTestId('settings-nav-updates')).toHaveTextContent('更新')
  })

  it('renders translated labels in SettingsAppearance', async () => {
    const { SettingsAppearance } = await import('@/components/settings/SettingsAppearance')
    render(<SettingsAppearance />)

    expect(screen.getByText('外观')).toBeInTheDocument()
    expect(screen.getByTestId('dark-themes-header')).toHaveTextContent('深色主题')
    expect(screen.getByTestId('light-themes-header')).toHaveTextContent('浅色主题')
  })

  it('renders translated labels in SettingsUpdates', async () => {
    const { SettingsUpdates } = await import('@/components/settings/SettingsUpdates')
    render(<SettingsUpdates />)

    expect(screen.getByText('更新')).toBeInTheDocument()
    expect(screen.getByText('更新通道')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('当前版本：')).toBeInTheDocument()
    })
  })

  it('translates file search and command palette copy', () => {
    expect(translate('zh-CN', 'fileSearch.placeholder')).toBe('按文件名或路径搜索...')
    expect(translate('zh-CN', 'fileTree.gitStatus.conflicted')).toBe('有冲突')
    expect(translate('zh-CN', 'fileTree.gitStatus.stagedSuffix')).toBe('（已暂存）')
    expect(translate('zh-CN', 'terminalToolbar.status.exited', { code: 1 })).toBe('已退出（1）')
    expect(translate('zh-CN', 'terminalToolbar.actions.clear')).toBe('清空终端（Cmd+K）')
    expect(translate('zh-CN', 'runOutputSearch.placeholder')).toBe('在输出中查找...')
    expect(translate('zh-CN', 'runOutputSearch.count', { current: 2, total: 5 })).toBe('2 / 5')
    expect(translate('zh-CN', 'setupTab.empty.configure')).toBe('配置 setup 脚本')
    expect(translate('zh-CN', 'setupTab.actions.rerun')).toBe('重新运行 Setup')
    expect(translate('zh-CN', 'copyMessageButton.ariaLabel')).toBe('复制消息')
    expect(translate('zh-CN', 'codeBlock.toasts.copied')).toBe('代码已复制到剪贴板')
    expect(translate('zh-CN', 'errorFallback.title')).toBe('出了点问题')
    expect(translate('zh-CN', 'errorFallback.retry')).toBe('重试')
    expect(translate('zh-CN', 'updateToast.available.skip')).toBe('跳过此版本')
    expect(translate('zh-CN', 'ghosttyPromoToast.activate')).toBe('启用')
    expect(translate('zh-CN', 'compactionPill.auto')).toBe('已自动压缩上下文')
    expect(translate('zh-CN', 'indeterminateProgressBar.working')).toBe('Agent 正在执行')
    expect(translate('zh-CN', 'gitCommitForm.summaryPlaceholder')).toBe('提交摘要')
    expect(translate('zh-CN', 'gitCommitForm.stagedCount', { count: 3, label: '文件' })).toBe(
      '3 个文件'
    )
    expect(translate('zh-CN', 'gitPushPull.merge.filterPlaceholder')).toBe('筛选分支...')
    expect(translate('zh-CN', 'gitPushPull.toasts.mergeSuccess', { branch: 'main' })).toBe(
      '已成功合并 main'
    )
    expect(translate('zh-CN', 'gitStatusPanel.sections.staged')).toBe('已暂存变更')
    expect(translate('zh-CN', 'gitStatusPanel.fileItem.viewChangesTitle', { path: 'a.ts' })).toBe(
      '查看变更：a.ts'
    )
    expect(translate('zh-CN', 'projectList.empty.noProjects')).toBe('还没有添加任何项目。')
    expect(translate('zh-CN', 'terminalManager.empty.selectWorktree')).toBe(
      '选择一个 worktree 以打开终端'
    )
    expect(translate('zh-CN', 'commandPalette.hints.goBack')).toBe('返回')
    expect(translate('zh-CN', 'recent.status.planReady')).toBe('计划已就绪')
    expect(translate('zh-CN', 'dialogs.gitInit.title')).toBe('不是 Git 仓库')
    expect(translate('zh-CN', 'dialogs.connect.connect')).toBe('连接')
    expect(translate('zh-CN', 'dialogs.addAttachment.placeholder')).toBe('粘贴 Jira 或 Figma 链接')
    expect(translate('zh-CN', 'header.controls.mergePR')).toBe('合并 PR')
    expect(translate('zh-CN', 'pinned.title')).toBe('已固定')
    expect(translate('zh-CN', 'pinned.menu.renameBranch')).toBe('重命名分支')
    expect(translate('zh-CN', 'pinned.menu.openInFileManager', { manager: 'Finder' })).toBe(
      '在 Finder 中打开'
    )
    expect(translate('zh-CN', 'pinned.menu.pin')).toBe('固定')
    expect(translate('zh-CN', 'pinned.status.archiving')).toBe('归档中')
    expect(translate('zh-CN', 'pinned.toasts.pathCopied')).toBe('路径已复制到剪贴板')
    expect(translate('zh-CN', 'projectItem.menu.openInFileManager', { manager: 'Finder' })).toBe(
      '在 Finder 中打开'
    )
    expect(translate('zh-CN', 'projectItem.toasts.createWorktreeError')).toBe('创建 worktree 失败')
  })
})
