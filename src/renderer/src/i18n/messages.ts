export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: AppLocale = 'en'

type MessageTree = {
  [key: string]: string | MessageTree
}

export const messages: Record<AppLocale, MessageTree> = {
  en: {
    settings: {
      title: 'Settings',
      sections: {
        appearance: 'Appearance',
        general: 'General',
        models: 'Models',
        editor: 'Editor',
        terminal: 'Terminal',
        security: 'Security',
        privacy: 'Privacy',
        shortcuts: 'Shortcuts',
        updates: 'Updates'
      },
      appearance: {
        title: 'Appearance',
        description: 'Choose a theme for the application.',
        darkThemes: 'Dark Themes',
        lightThemes: 'Light Themes'
      },
      general: {
        title: 'General',
        description: 'Basic application settings',
        language: {
          label: 'Language',
          description:
            'Choose the display language for translated UI copy. More screens will be localized incrementally.',
          options: {
            en: 'English',
            zhCN: 'Simplified Chinese'
          }
        },
        autoStartSession: {
          label: 'Auto-start session',
          description: 'Automatically create a session when selecting a worktree with none'
        },
        vimMode: {
          label: 'Vim mode',
          description:
            'Enable vim-style keyboard navigation with hints, hjkl scrolling, and mode switching'
        },
        modelIcons: {
          label: 'Model icons',
          description: 'Show the model icon (Claude, OpenAI) next to the worktree status'
        },
        modelProvider: {
          label: 'Show model provider',
          description:
            'Display the provider name (e.g. ANTHROPIC) next to the model in the selector pill'
        },
        usageIndicator: {
          label: 'Show usage indicator',
          description:
            'Show Claude API usage bars below projects. When off, shows spaces tab instead.'
        },
        aiProvider: {
          label: 'AI Provider',
          description:
            'Choose which AI coding agent to use for new sessions. Existing sessions keep their original provider.',
          terminalHint:
            'Opens a terminal window. Run any AI tool manually (claude, aider, cursor, etc.)'
        },
        stripAtMentions: {
          label: 'Strip @ from file mentions',
          description:
            'Remove the @ symbol from file references inserted via the file picker before sending'
        },
        branchNaming: {
          label: 'Branch Naming',
          description: 'Choose the naming theme for auto-generated worktree branches',
          options: {
            dogs: 'Dogs',
            cats: 'Cats'
          }
        },
        resetAll: {
          label: 'Reset all settings',
          description:
            'This will reset all settings, theme, and keyboard shortcuts to their defaults.',
          success: 'All settings reset to defaults'
        }
      },
      editor: {
        title: 'Editor',
        description: 'Choose which editor to use for "Open in Editor" actions',
        detecting: 'Detecting installed editors...',
        notFound: '(not found)',
        customCommand: {
          label: 'Custom Editor Command',
          description: 'The command will be called with the worktree path as an argument.',
          optionLabel: 'Custom Command'
        }
      },
      models: {
        title: 'Default Models',
        description: 'Configure which AI models to use for different modes and commands',
        priority: {
          title: 'Model selection priority:',
          worktree: "Worktree's last-used model (if any)",
          mode: 'Mode-specific default (configured below)',
          global: 'Global default model',
          fallback: 'System fallback (Claude Opus 4.5)'
        },
        global: {
          label: 'Global Default Model',
          fallbackDescription: 'Fallback model used when no mode-specific default is configured',
          sessionDescription: 'Model used for all new sessions',
          clear: 'Clear'
        },
        build: {
          label: 'Build Mode Default',
          description: 'Model used for new build mode sessions (normal coding)'
        },
        plan: {
          label: 'Plan Mode Default',
          description: 'Model used for new plan mode sessions (design and planning)'
        },
        ask: {
          label: '/ask Command Default',
          description: 'Model used when you run the /ask command for quick questions'
        },
        useGlobal: 'Use global'
      },
      terminal: {
        embedded: {
          title: 'Embedded Terminal',
          description: 'Choose the rendering engine for the built-in terminal panel',
          xtermLabel: 'Built-in (xterm.js)',
          xtermDescription: 'Cross-platform terminal emulator. Always available.',
          ghosttyLabel: 'Ghostty (native)',
          ghosttyDescription: 'Native Metal rendering on macOS. Requires Ghostty.',
          macOnly: '(macOS only)',
          notAvailable: '(not available)',
          info: 'Ghostty renders via Metal for native performance. The terminal will restart when switching backends. Colors and cursor style are read from your Ghostty config.',
          fontSizeLabel: 'Font Size',
          fontSizeUnit: 'pt (8-32)',
          fontSizeDescription:
            'Font size for the embedded Ghostty terminal. Restart the terminal for changes to take effect.'
        },
        external: {
          title: 'External Terminal',
          description: 'Choose which terminal to use for "Open in Terminal" actions',
          detecting: 'Detecting installed terminals...',
          notFound: '(not found)',
          customCommand: {
            label: 'Custom Terminal Command',
            description: 'The command will be called with the worktree path as an argument.',
            optionLabel: 'Custom Command'
          }
        }
      },
      security: {
        title: 'Security',
        description: 'Control command filtering for approval-based agent sessions',
        enable: {
          label: 'Enable command filtering',
          description:
            'Control which tools and commands approval-based agents can use during sessions'
        },
        defaultBehavior: {
          label: 'Default behavior for unlisted commands',
          description: 'How to handle commands not on either list',
          ask: 'Ask for approval',
          allow: 'Allow silently',
          block: 'Block silently'
        },
        info: {
          title: 'Pattern matching with wildcards:',
          single: '* matches any sequence except /',
          double: '** matches any sequence including /',
          exampleBash: 'Example: bash: npm * matches all npm commands',
          exampleRead: 'Example: read: src/** matches any file in src/'
        },
        priority: {
          title: 'Priority:',
          description:
            'Blocklist takes precedence over allowlist. If a command matches both, it will be blocked.'
        },
        tabs: {
          allowlist: 'Allowlist',
          blocklist: 'Blocklist'
        },
        pattern: {
          empty: 'Pattern cannot be empty',
          duplicate: 'Pattern already exists in this list',
          added: 'Pattern added to {list}',
          removed: 'Pattern removed from {list}',
          allowPlaceholder: 'e.g., bash: git status or read: src/**',
          blockPlaceholder: 'e.g., bash: rm -rf * or edit: .env',
          add: 'Add',
          searchPlaceholder: 'Search patterns...',
          showingCount: 'Showing {visible} of {total} patterns',
          noAllowlist: 'No patterns in allowlist. Commands will follow the default behavior.',
          noAllowlistSearch: 'No patterns matching "{query}"',
          noBlocklist:
            'No patterns in blocklist. Default dangerous patterns are included on first launch.',
          noBlocklistSearch: 'No patterns matching "{query}"',
          removeTitle: 'Remove pattern'
        }
      },
      privacy: {
        title: 'Privacy',
        description: 'Control how Hive collects anonymous usage data',
        analytics: {
          label: 'Send anonymous usage analytics',
          description: 'Help improve Hive by sharing anonymous feature usage data'
        },
        collect: {
          title: 'What we collect:',
          description: 'Feature usage counts, app version, platform (macOS/Windows/Linux).'
        },
        neverCollect: {
          title: 'What we never collect:',
          description:
            'Project names, file contents, prompts, AI responses, git data, or any personal information.'
        }
      },
      shortcuts: {
        title: 'Keyboard Shortcuts',
        description: 'Customize keyboard shortcuts',
        resetAll: 'Reset All',
        resetAllSuccess: 'All shortcuts reset to defaults',
        resetOneSuccess: 'Shortcut reset to default',
        modifierRequired: 'Shortcuts must include at least one modifier key (Cmd/Ctrl/Alt/Shift)',
        updated: 'Shortcut updated to {binding}',
        conflictTitle: 'Shortcut conflict',
        conflictDescription: 'This binding is already used by:',
        resetTitle: 'Reset to default',
        recording: 'Press keys...',
        categories: {
          recent: 'Recent',
          navigation: 'Navigation',
          action: 'Actions',
          git: 'Git',
          settings: 'Settings',
          file: 'File'
        }
      },
      updates: {
        title: 'Updates',
        description: 'Manage how Hive updates itself',
        currentVersion: 'Current version:',
        channel: {
          label: 'Update Channel',
          description: 'Choose which release channel to receive updates from',
          stable: 'Stable',
          canary: 'Canary',
          stableHint: 'You will receive stable, tested releases.',
          canaryHint:
            'You will receive early builds with the latest features. These may contain bugs.'
        },
        check: {
          idle: 'Check for Updates',
          busy: 'Checking...'
        }
      }
    },
    fileSearch: {
      ariaLabel: 'File search',
      commandLabel: 'File search',
      placeholder: 'Search files by name or path...',
      empty: 'No files found.',
      hints: {
        navigate: 'navigate',
        open: 'open',
        close: 'close'
      },
      fileCount: '{count} files'
    },
    commandPalette: {
      ariaLabel: 'Command palette',
      commandLabel: 'Command palette',
      backAriaLabel: 'Go back',
      placeholderRoot: 'Type a command or search...',
      placeholderIn: 'Search in {label}...',
      empty: 'No commands found.',
      results: 'Results',
      hints: {
        navigate: 'navigate',
        select: 'select',
        close: 'close',
        goBack: 'go back'
      },
      categories: {
        recent: 'Recent',
        navigation: 'Navigation',
        action: 'Actions',
        git: 'Git',
        settings: 'Settings',
        file: 'File'
      }
    },
    sidebar: {
      projects: 'Projects',
      filterProjects: 'Filter projects...',
      recentToggleTitle: 'Toggle recent activity',
      sortProjectsTitle: 'Sort by last message',
      addProjectTitle: 'Add Project',
      connectionMode: {
        selectWorktrees: 'Select worktrees',
        cancel: 'Cancel',
        connect: 'Connect',
        connecting: 'Connecting...'
      }
    },
    recent: {
      title: 'Recent',
      connectionFallback: 'Connection',
      status: {
        answering: 'Answer questions',
        permission: 'Permission',
        planning: 'Planning',
        working: 'Working',
        planReady: 'Plan ready',
        ready: 'Ready'
      }
    }
  },
  'zh-CN': {
    settings: {
      title: '设置',
      sections: {
        appearance: '外观',
        general: '通用',
        models: '模型',
        editor: '编辑器',
        terminal: '终端',
        security: '安全',
        privacy: '隐私',
        shortcuts: '快捷键',
        updates: '更新'
      },
      appearance: {
        title: '外观',
        description: '为应用选择主题。',
        darkThemes: '深色主题',
        lightThemes: '浅色主题'
      },
      general: {
        title: '通用',
        description: '基础应用设置',
        language: {
          label: '语言',
          description: '选择已接入翻译的界面语言。其余界面会逐步迁移到 i18n。',
          options: {
            en: 'English',
            zhCN: '简体中文'
          }
        },
        autoStartSession: {
          label: '自动启动会话',
          description: '当选中一个尚无会话的 worktree 时，自动创建新会话'
        },
        vimMode: {
          label: 'Vim 模式',
          description: '启用 Vim 风格键盘导航，包括 hints、hjkl 滚动和模式切换'
        },
        modelIcons: {
          label: '模型图标',
          description: '在 worktree 状态旁显示模型图标（Claude、OpenAI）'
        },
        modelProvider: {
          label: '显示模型提供方',
          description: '在模型选择器里显示提供方名称，例如 ANTHROPIC'
        },
        usageIndicator: {
          label: '显示用量指示器',
          description: '在项目下方显示 Claude API 用量条。关闭后会显示 spaces 标签页。'
        },
        aiProvider: {
          label: 'AI 提供方',
          description: '为新会话选择默认 AI 编码代理。已有会话会保留原来的 provider。',
          terminalHint: '打开终端窗口，由你手动运行 claude、aider、cursor 等任意 AI 工具'
        },
        stripAtMentions: {
          label: '发送前去掉文件提及中的 @',
          description: '通过文件选择器插入文件引用后，在发送前移除前缀 @ 符号'
        },
        branchNaming: {
          label: '分支命名',
          description: '为自动生成的 worktree 分支选择命名主题',
          options: {
            dogs: '狗',
            cats: '猫'
          }
        },
        resetAll: {
          label: '重置全部设置',
          description: '这会把所有设置、主题和快捷键恢复到默认值。',
          success: '所有设置已恢复默认值'
        }
      },
      editor: {
        title: '编辑器',
        description: '选择 “Open in Editor” 操作默认打开的编辑器',
        detecting: '正在检测已安装的编辑器...',
        notFound: '（未找到）',
        customCommand: {
          label: '自定义编辑器命令',
          description: '调用该命令时会把 worktree 路径作为参数传入。',
          optionLabel: '自定义命令'
        }
      },
      models: {
        title: '默认模型',
        description: '配置不同模式和命令默认使用的 AI 模型',
        priority: {
          title: '模型选择优先级：',
          worktree: 'Worktree 上次使用的模型（如果有）',
          mode: '模式专属默认模型（下方配置）',
          global: '全局默认模型',
          fallback: '系统兜底模型（Claude Opus 4.5）'
        },
        global: {
          label: '全局默认模型',
          fallbackDescription: '当未配置模式专属默认模型时使用的兜底模型',
          sessionDescription: '所有新会话默认使用的模型',
          clear: '清除'
        },
        build: {
          label: 'Build 模式默认模型',
          description: '新建 build 模式会话时使用的模型（常规编码）'
        },
        plan: {
          label: 'Plan 模式默认模型',
          description: '新建 plan 模式会话时使用的模型（设计与规划）'
        },
        ask: {
          label: '/ask 命令默认模型',
          description: '执行 /ask 命令进行快速提问时使用的模型'
        },
        useGlobal: '使用全局默认'
      },
      terminal: {
        embedded: {
          title: '内置终端',
          description: '选择内置终端面板使用的渲染引擎',
          xtermLabel: '内置（xterm.js）',
          xtermDescription: '跨平台终端模拟器，始终可用。',
          ghosttyLabel: 'Ghostty（原生）',
          ghosttyDescription: 'macOS 上的原生 Metal 渲染，需要安装 Ghostty。',
          macOnly: '（仅 macOS）',
          notAvailable: '（不可用）',
          info: 'Ghostty 通过 Metal 提供更原生的渲染性能。切换后端时终端会重启。颜色和光标样式会读取你的 Ghostty 配置。',
          fontSizeLabel: '字体大小',
          fontSizeUnit: 'pt（8-32）',
          fontSizeDescription: '内置 Ghostty 终端的字体大小。修改后需重启终端才能生效。'
        },
        external: {
          title: '外部终端',
          description: '选择 “Open in Terminal” 操作默认打开的终端',
          detecting: '正在检测已安装的终端...',
          notFound: '（未找到）',
          customCommand: {
            label: '自定义终端命令',
            description: '调用该命令时会把 worktree 路径作为参数传入。',
            optionLabel: '自定义命令'
          }
        }
      },
      security: {
        title: '安全',
        description: '控制基于审批的 agent 会话中的命令过滤规则',
        enable: {
          label: '启用命令过滤',
          description: '控制需要审批的 agent 在会话中可以使用哪些工具和命令'
        },
        defaultBehavior: {
          label: '未列出命令的默认行为',
          description: '命令不在任一列表中时应如何处理',
          ask: '请求审批',
          allow: '静默允许',
          block: '静默拦截'
        },
        info: {
          title: '支持通配符的模式匹配：',
          single: '* 匹配除 / 之外的任意字符序列',
          double: '** 匹配包含 / 在内的任意字符序列',
          exampleBash: '示例：bash: npm * 可匹配所有 npm 命令',
          exampleRead: '示例：read: src/** 可匹配 src/ 下任意文件'
        },
        priority: {
          title: '优先级：',
          description: 'Blocklist 的优先级高于 allowlist。若一个命令同时匹配两者，会被拦截。'
        },
        tabs: {
          allowlist: '允许列表',
          blocklist: '拦截列表'
        },
        pattern: {
          empty: '模式不能为空',
          duplicate: '该模式已存在于当前列表中',
          added: '已将模式添加到{list}',
          removed: '已从{list}移除模式',
          allowPlaceholder: '例如：bash: git status 或 read: src/**',
          blockPlaceholder: '例如：bash: rm -rf * 或 edit: .env',
          add: '添加',
          searchPlaceholder: '搜索模式...',
          showingCount: '显示 {visible} / {total} 条模式',
          noAllowlist: '允许列表中还没有模式。命令会按默认行为处理。',
          noAllowlistSearch: '没有匹配 “{query}” 的模式',
          noBlocklist: '拦截列表中还没有模式。首次启动时会包含默认危险模式。',
          noBlocklistSearch: '没有匹配 “{query}” 的模式',
          removeTitle: '移除模式'
        }
      },
      privacy: {
        title: '隐私',
        description: '控制 Hive 如何收集匿名使用数据',
        analytics: {
          label: '发送匿名使用分析数据',
          description: '通过共享匿名功能使用数据帮助改进 Hive'
        },
        collect: {
          title: '我们会收集：',
          description: '功能使用次数、应用版本、平台信息（macOS/Windows/Linux）。'
        },
        neverCollect: {
          title: '我们绝不会收集：',
          description: '项目名称、文件内容、提示词、AI 回复、git 数据或任何个人信息。'
        }
      },
      shortcuts: {
        title: '键盘快捷键',
        description: '自定义键盘快捷键',
        resetAll: '重置全部',
        resetAllSuccess: '所有快捷键已恢复默认值',
        resetOneSuccess: '快捷键已恢复默认值',
        modifierRequired: '快捷键必须至少包含一个修饰键（Cmd/Ctrl/Alt/Shift）',
        updated: '快捷键已更新为 {binding}',
        conflictTitle: '快捷键冲突',
        conflictDescription: '该按键已被以下操作占用：',
        resetTitle: '恢复默认',
        recording: '请按下按键...',
        categories: {
          recent: '最近',
          navigation: '导航',
          action: '操作',
          git: 'Git',
          settings: '设置',
          file: '文件'
        }
      },
      updates: {
        title: '更新',
        description: '管理 Hive 的更新方式',
        currentVersion: '当前版本：',
        channel: {
          label: '更新通道',
          description: '选择接收更新的发布通道',
          stable: '稳定版',
          canary: '金丝雀版',
          stableHint: '你将接收稳定且经过测试的版本。',
          canaryHint: '你将接收包含最新功能的早期构建版本，这些版本可能包含 bug。'
        },
        check: {
          idle: '检查更新',
          busy: '检查中...'
        }
      }
    },
    fileSearch: {
      ariaLabel: '文件搜索',
      commandLabel: '文件搜索',
      placeholder: '按文件名或路径搜索...',
      empty: '没有找到文件。',
      hints: {
        navigate: '导航',
        open: '打开',
        close: '关闭'
      },
      fileCount: '{count} 个文件'
    },
    commandPalette: {
      ariaLabel: '命令面板',
      commandLabel: '命令面板',
      backAriaLabel: '返回上一级',
      placeholderRoot: '输入命令或开始搜索...',
      placeholderIn: '在 {label} 中搜索...',
      empty: '没有找到命令。',
      results: '结果',
      hints: {
        navigate: '导航',
        select: '选择',
        close: '关闭',
        goBack: '返回'
      },
      categories: {
        recent: '最近',
        navigation: '导航',
        action: '操作',
        git: 'Git',
        settings: '设置',
        file: '文件'
      }
    },
    sidebar: {
      projects: '项目',
      filterProjects: '筛选项目...',
      recentToggleTitle: '切换最近活动视图',
      sortProjectsTitle: '按最近消息排序',
      addProjectTitle: '添加项目',
      connectionMode: {
        selectWorktrees: '选择 worktree',
        cancel: '取消',
        connect: '连接',
        connecting: '连接中...'
      }
    },
    recent: {
      title: '最近',
      connectionFallback: '连接',
      status: {
        answering: '等待回答',
        permission: '等待授权',
        planning: '规划中',
        working: '执行中',
        planReady: '计划已就绪',
        ready: '就绪'
      }
    }
  }
}
