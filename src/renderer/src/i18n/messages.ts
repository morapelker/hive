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
    fileTree: {
      gitStatus: {
        modified: 'Modified',
        staged: 'Staged',
        deleted: 'Deleted',
        untracked: 'Untracked',
        conflicted: 'Conflicted',
        stagedSuffix: ' (staged)'
      }
    },
    terminalToolbar: {
      status: {
        starting: 'Starting...',
        terminal: 'Terminal',
        ghostty: 'Ghostty',
        exited: 'Exited ({code})'
      },
      search: {
        placeholder: 'Search...',
        previous: 'Previous match (Shift+Enter)',
        next: 'Next match (Enter)',
        close: 'Close search (Escape)'
      },
      actions: {
        search: 'Search (Cmd+F)',
        clear: 'Clear terminal (Cmd+K)',
        restart: 'Restart terminal'
      }
    },
    runOutputSearch: {
      placeholder: 'Find in output...',
      count: '{current} of {total}',
      noResults: 'No results',
      previous: 'Previous match (Shift+Enter)',
      next: 'Next match (Enter)',
      close: 'Close (Escape)'
    },
    setupTab: {
      empty: {
        noWorktree: 'Select a worktree to view setup output',
        noOutput: 'No setup output yet. Click "Rerun Setup" to execute.',
        configure: 'Configure setup script'
      },
      status: {
        running: 'Running...',
        complete: 'Setup complete',
        failed: 'Setup failed'
      },
      actions: {
        rerun: 'Rerun Setup'
      }
    },
    copyMessageButton: {
      ariaLabel: 'Copy message',
      toasts: {
        copied: 'Copied to clipboard',
        copyError: 'Failed to copy'
      }
    },
    codeBlock: {
      copyButton: 'Copy code',
      toasts: {
        copied: 'Code copied to clipboard',
        copyError: 'Failed to copy code'
      }
    },
    errorFallback: {
      title: 'Something went wrong',
      message: 'An unexpected error occurred',
      retry: 'Try Again'
    },
    updateToast: {
      available: {
        title: 'Update v{version} available',
        later: 'Later',
        skip: 'Skip this version',
        download: 'Download'
      },
      progress: {
        title: 'Downloading v{version}...'
      }
    },
    ghosttyPromoToast: {
      title: 'Ghostty native terminal available',
      description: 'Metal-accelerated rendering with your Ghostty config',
      dismiss: "Don't show again",
      activate: 'Activate'
    },
    compactionPill: {
      auto: 'Auto-compacted',
      manual: 'Context compacted'
    },
    indeterminateProgressBar: {
      asking: 'Waiting for answer',
      working: 'Agent is working'
    },
    gitCommitForm: {
      summaryPlaceholder: 'Commit summary',
      descriptionPlaceholder: 'Extended description (optional)',
      committing: 'Committing...',
      commit: 'Commit',
      stagedCount: '{count} {label}',
      fileSingular: 'file',
      filePlural: 'files',
      conflictWarning: 'Resolve merge conflicts before committing',
      shortcutHint: '{modifier}+Enter to commit',
      toasts: {
        success: 'Changes committed successfully',
        commitHash: 'Commit: {hash}',
        error: 'Failed to commit'
      }
    },
    gitPushPull: {
      actions: {
        push: 'Push',
        pull: 'Pull',
        merge: 'Merge',
        archive: 'Archive',
        delete: 'Delete'
      },
      merge: {
        label: 'Merge from',
        select: 'Select branch',
        filterPlaceholder: 'Filter branches...',
        loading: 'Loading...',
        noMatching: 'No matching branches',
        noBranches: 'No branches found'
      },
      toasts: {
        pushSuccess: 'Pushed successfully',
        pushError: 'Push failed',
        pullSuccess: 'Pulled successfully',
        pullError: 'Pull failed',
        deleteSuccess: 'Deleted branch {branch}',
        deleteError: 'Failed to delete branch',
        mergeSuccess: 'Merged {branch} successfully',
        mergeError: 'Merge failed'
      }
    },
    gitStatusPanel: {
      ariaLabel: 'Git status',
      loading: 'Loading...',
      refresh: 'Refresh git status',
      noChanges: 'No changes',
      ahead: '{count} commit(s) ahead',
      behind: '{count} commit(s) behind',
      conflictsTitle: '{count} file(s) with merge conflicts - click to fix with AI',
      conflictsButton: 'CONFLICTS',
      unknownBranch: 'unknown',
      conflictSessionName: 'Merge Conflicts: {branch}',
      pendingMessage: 'Fix merge conflicts',
      sections: {
        conflicts: 'Conflicts',
        staged: 'Staged Changes',
        changes: 'Changes',
        untracked: 'Untracked'
      },
      actions: {
        stageAll: 'Stage All',
        stageAllTitle: 'Stage all files',
        unstageAll: 'Unstage All',
        unstageAllTitle: 'Unstage all files'
      },
      fileItem: {
        stageFile: 'Stage {path}',
        unstageFile: 'Unstage {path}',
        viewChanges: 'View changes',
        viewChangesTitle: 'View changes: {path}'
      },
      toasts: {
        stageAllSuccess: 'All changes staged',
        stageAllError: 'Failed to stage changes',
        unstageAllSuccess: 'All changes unstaged',
        unstageAllError: 'Failed to unstage changes',
        stageFileError: 'Failed to stage {path}',
        unstageFileError: 'Failed to unstage {path}',
        noWorktreeSelected: 'No worktree selected',
        projectNotFound: 'Could not find project for worktree',
        createSessionError: 'Failed to create session',
        conflictResolutionError: 'Failed to start conflict resolution'
      }
    },
    projectList: {
      error: {
        title: 'Failed to load projects'
      },
      empty: {
        noProjects: 'No projects added yet.',
        addProjectHint: 'Click + to add a project.',
        noProjectsInSpace: 'No projects in this space.',
        assignHint: 'Right-click a project to assign it.',
        noMatches: 'No matching projects'
      }
    },
    terminalManager: {
      empty: {
        selectWorktree: 'Select a worktree to open a terminal'
      }
    },
    appLayout: {
      sidebarError: 'Sidebar Error',
      drop: {
        noSession: 'Open a session to attach files',
        noFolders: 'Folders cannot be attached. Drop individual files instead.',
        maxFiles: 'Maximum {count} files per drop',
        readError: 'Failed to read one or more dropped files'
      }
    },
    loading: {
      default: 'Loading...'
    },
    connectionList: {
      title: 'Connections'
    },
    prReview: {
      viewer: {
        loading: 'Loading review comments...',
        retry: 'Retry',
        empty: 'No review comments on this PR',
        refresh: 'Refresh comments',
        allHidden: 'All comments hidden by filters',
        selectedCount: '{count} selected',
        selectAll: 'Select all',
        deselect: 'Deselect',
        addToChat: 'Add to chat',
        reviewer: {
          show: "Show {login}'s comments",
          hide: "Hide {login}'s comments"
        }
      },
      store: {
        fetchError: 'Failed to fetch comments',
        unknownReviewer: 'unknown reviewer',
        unknownPath: 'unknown'
      },
      commentCard: {
        copied: 'Raw comment HTML copied',
        outdated: 'old',
        copyRawHtml: 'Copy raw HTML'
      }
    },
    toolViews: {
      common: {
        showLess: 'Show less',
        showAllLines: 'Show all {count} lines'
      },
      grep: {
        in: 'in',
        matchCount: '{count} {label}',
        matchSingular: 'match',
        matchPlural: 'matches',
        noMatches: 'No matches found',
        showAllResults: 'Show all {count} results'
      },
      read: {
        linesRange: 'Lines {start}-{end}',
        fromLine: 'From line {start}',
        firstLines: 'First {count} lines'
      },
      fileChange: {
        add: 'Add',
        delete: 'Delete',
        update: 'Update',
        moreLines: '... {count} more lines',
        noDiffContent: 'No diff content',
        noChanges: 'No file changes'
      },
      edit: {
        lineCount: '{count} {label}',
        lineSingular: 'line',
        linePlural: 'lines',
        moreRemoved: '... {count} more removed',
        moreAdded: '... {count} more added',
        noChanges: 'No changes'
      },
      fallback: {
        todo: 'TODO',
        error: 'Error',
        input: 'Input',
        output: 'Output',
        note: 'No custom renderer - showing raw data'
      },
      skill: {
        loading: 'Loading skill...'
      },
      exitPlan: {
        empty: 'No plan content available.'
      },
      todo: {
        empty: 'No tasks'
      },
      webFetch: {
        bytesSingular: '{count} byte',
        bytesPlural: '{count} bytes',
        kb: '{value} KB',
        mb: '{value} MB'
      },
      lsp: {
        noHover: 'No hover information',
        noResults: 'No results found',
        noDiagnostics: 'No diagnostics found',
        unknown: 'unknown',
        showAll: 'Show all {count} {label}',
        labels: {
          locations: 'locations',
          calls: 'calls',
          symbols: 'symbols',
          diagnostics: 'diagnostics'
        },
        operations: {
          definition: 'definition',
          hover: 'hover',
          references: 'references',
          symbols: 'symbols',
          workspaceSymbols: 'workspace symbols',
          implementation: 'implementation',
          callers: 'callers',
          callees: 'callees',
          diagnostics: 'diagnostics'
        },
        symbolKinds: {
          file: 'file',
          module: 'module',
          namespace: 'namespace',
          package: 'package',
          class: 'class',
          method: 'method',
          property: 'property',
          field: 'field',
          constructor: 'constructor',
          enum: 'enum',
          interface: 'interface',
          function: 'function',
          variable: 'variable',
          constant: 'constant',
          string: 'string',
          number: 'number',
          boolean: 'boolean',
          array: 'array',
          object: 'object',
          key: 'key',
          null: 'null',
          enumMember: 'enum member',
          struct: 'struct',
          event: 'event',
          operator: 'operator',
          typeParam: 'type param'
        }
      },
      task: {
        defaultTitle: 'Sub-agent',
        prompt: 'Prompt'
      }
    },
    contextIndicator: {
      title: 'Context Window',
      summary: {
        withLimit: '{used} / {limit} tokens ({percent}%)',
        noLimit: '{used} tokens (limit unavailable)'
      },
      labels: {
        input: 'Input',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write'
      },
      generated: {
        title: 'Generated (not in context)',
        output: 'Output',
        reasoning: 'Reasoning'
      },
      cost: {
        session: 'Session cost: {cost}'
      }
    },
    helpOverlay: {
      title: 'Keyboard Shortcuts',
      mode: {
        normal: 'NORMAL',
        insert: 'INSERT'
      },
      sections: {
        vimNavigation: 'Vim Navigation',
        panelShortcuts: 'Panel Shortcuts',
        actionShortcuts: 'Action Shortcuts',
        sidebarHints: 'Sidebar Hints',
        sessionHints: 'Session Hints',
        systemShortcuts: 'System Shortcuts'
      },
      rows: {
        navigateWorktrees: 'Navigate worktrees',
        navigateSessionTabs: 'Navigate session tabs',
        filterProjectsInsert: 'Filter projects (insert mode)',
        returnToNormalMode: 'Return to normal mode',
        toggleHelp: 'Toggle this help',
        prevNextFileTab: 'Prev / Next file tab'
      },
      panels: {
        changes: 'Changes',
        files: 'Files',
        diffs: 'Diffs',
        setup: 'Setup',
        run: 'Run',
        terminal: 'Terminal'
      },
      actions: {
        review: 'Review',
        pr: 'PR',
        mergePr: 'Merge PR',
        archive: 'Archive'
      },
      dynamic: {
        pinnedPrefix: '[pin] {name}',
        connectionFallback: 'Connection'
      }
    },
    keyboardShortcuts: {
      items: {
        sessionNew: 'New Session',
        sessionClose: 'Close Session',
        sessionModeToggle: 'Toggle Build/Plan Mode',
        projectRun: 'Run Project',
        modelCycleVariant: 'Cycle Model Variant',
        navFileSearch: 'Search Files',
        navCommandPalette: 'Open Command Palette',
        navSessionHistory: 'Open Session History',
        navNewWorktree: 'New Worktree',
        gitCommit: 'Focus Commit Form',
        gitPush: 'Push to Remote',
        gitPull: 'Pull from Remote',
        navFilterProjects: 'Filter Projects',
        sidebarToggleLeft: 'Toggle Left Sidebar',
        sidebarToggleRight: 'Toggle Right Sidebar',
        focusLeftSidebar: 'Focus Left Sidebar',
        focusMainPane: 'Focus Main Pane',
        settingsOpen: 'Open Settings'
      }
    },
    connectionStore: {
      toasts: {
        unknownError: 'Unknown error',
        createError: 'Failed to create connection: {error}',
        createSuccess: 'Connection "{name}" created',
        deleteError: 'Failed to delete connection',
        deleteErrorWithReason: 'Failed to delete connection: {error}',
        deleteSuccess: 'Connection deleted',
        addMemberError: 'Failed to add member: {error}',
        removeMemberError: 'Failed to remove member: {error}',
        notFound: 'Connection not found',
        updateSuccess: 'Connection updated',
        updateError: 'Failed to update connection: {error}',
        renameError: 'Failed to rename connection',
        renameErrorWithReason: 'Failed to rename connection: {error}'
      }
    },
    pinnedStore: {
      toasts: {
        pinConnectionError: 'Failed to pin connection',
        unpinConnectionError: 'Failed to unpin connection'
      }
    },
    sessionStore: {
      errors: {
        createConnectionSession: 'Failed to create connection session'
      }
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
      filterPopover: {
        noMatchingCommands: 'No matching commands',
        noMatchingLanguages: 'No matching languages'
      },
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
        commandApproval: 'Approve command',
        permission: 'Permission',
        planning: 'Planning',
        working: 'Working',
        planReady: 'Plan ready',
        ready: 'Ready'
      }
    },
    dialogs: {
      archiveConfirm: {
        title: 'Uncommitted Changes',
        description: '{worktreeName} has uncommitted changes that will be permanently lost.',
        binary: 'binary',
        noChanges: 'no changes',
        moreFiles: '+{count} more {label}',
        fileSingular: 'file',
        filePlural: 'files',
        cancel: 'Cancel',
        confirm: 'Archive Anyway'
      },
      gitInit: {
        title: 'Not a Git Repository',
        selectedFolder: 'The selected folder is not a Git repository:',
        question: 'Would you like to initialize a new Git repository?',
        cancel: 'Cancel',
        confirm: 'Initialize Repository'
      },
      connect: {
        title: 'Connect Worktrees',
        description: 'Select worktrees from other projects to connect into a shared workspace.',
        existingConnections: 'Existing Connections',
        addToExisting: 'Add to Existing Connection',
        filterPlaceholder: 'Filter worktrees...',
        noWorktrees: 'No worktrees from other projects available.',
        noWorktreesHint: 'Add another project to Hive first.',
        noMatches: 'No worktrees match your filter',
        selectedCount: '{count} {label} selected',
        selectedNone: 'Select worktrees to connect',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktrees',
        connect: 'Connect',
        connecting: 'Connecting...'
      },
      manageConnectionWorktrees: {
        title: 'Connection Worktrees',
        description: 'Manage which worktrees are part of this connection.',
        filterPlaceholder: 'Filter worktrees...',
        noWorktrees: 'No active worktrees found.',
        noMatches: 'No worktrees match your filter',
        selectedNone: 'Select at least 1 worktree',
        selectedCount: '{count} {label} selected',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktrees',
        save: 'Save',
        saving: 'Saving...'
      },
      addAttachment: {
        title: 'Add Attachment',
        placeholder: 'Paste a Jira or Figma URL',
        detected: {
          jira: 'Jira ticket',
          figma: 'Figma file'
        },
        unsupportedUrl: 'Unsupported URL',
        confirm: 'Add',
        toasts: {
          added: 'Attached {type}: {label}',
          addError: 'Failed to add attachment'
        }
      },
      projectSettings: {
        title: 'Project Settings',
        icon: {
          label: 'Project Icon',
          description: 'Custom icon displayed in the sidebar. Supports SVG, PNG, JPG, and WebP.',
          change: 'Change',
          changing: 'Picking...',
          clear: 'Clear',
          pickError: 'Failed to pick icon',
          removeError: 'Failed to remove icon'
        },
        autoAssignPort: {
          label: 'Auto-assign Port',
          description:
            'Assign a unique port to each worktree and inject PORT into run/setup scripts. Ports start at 3011.'
        },
        setupScript: {
          label: 'Setup Script',
          description:
            'Commands to run when a new worktree is initialized. Each line is a separate command.',
          placeholder: 'pnpm install\npnpm run build'
        },
        runScript: {
          label: 'Run Script',
          description: 'Commands triggered by ⌘R. Press ⌘R again while running to stop.',
          placeholder: 'pnpm run dev'
        },
        archiveScript: {
          label: 'Archive Script',
          description: "Commands to run before worktree archival. Failures won't block archival.",
          placeholder: 'pnpm run clean'
        },
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving...',
        saveSuccess: 'Project settings saved',
        saveError: 'Failed to save project settings'
      },
      branchPicker: {
        title: 'New Workspace',
        description: 'Select a branch or pull request to create a new workspace from.',
        tabs: {
          branches: 'Branches',
          prs: 'PRs'
        },
        filterBranches: 'Filter branches...',
        filterPRs: 'Filter pull requests...',
        loadingBranches: 'Loading branches...',
        noBranchesMatch: 'No branches match your filter',
        noBranches: 'No branches found',
        remote: 'remote',
        active: 'active',
        loadingPRs: 'Loading pull requests...',
        noPRsMatch: 'No pull requests match your filter',
        noPRs: 'No open pull requests',
        branchCount: '{count} {label}{match}',
        prCount: '{count} {label}{match}',
        branchSingular: 'branch',
        branchPlural: 'branches',
        prSingular: 'pull request',
        prPlural: 'pull requests',
        matching: ' matching "{query}"'
      }
    },
    header: {
      controls: {
        fixConflicts: 'Fix conflicts',
        fixingConflicts: 'Fixing conflicts...',
        archiveWorktreeTitle: 'Archive worktree',
        archive: 'Archive',
        archiving: 'Archiving...',
        mergePRTitle: 'Merge Pull Request',
        mergePR: 'Merge PR',
        merging: 'Merging...',
        reviewTitle: 'Review branch changes with AI',
        review: 'Review',
        noRemoteBranches: 'No remote branches',
        attached: 'Attached',
        loadingPRs: 'Loading PRs...',
        noOpenPRs: 'No open PRs found',
        detachPR: 'Detach PR',
        createPRTitle: 'Create Pull Request (right-click to attach existing)',
        attachExistingPR: 'Attach existing PR',
        sessionHistoryTitle: 'Session History (⌘K)',
        settingsTitle: 'Settings (⌘,)',
        showSidebar: 'Show sidebar',
        hideSidebar: 'Hide sidebar',
        merged: 'merged',
        closed: 'closed'
      }
    },
    pinned: {
      title: 'Pinned',
      connectionFallback: 'Connection',
      connectionNamePlaceholder: 'Connection name',
      menu: {
        open: 'Open',
        detach: 'Detach',
        addAttachment: 'Add Attachment',
        editContext: 'Edit Context',
        openInTerminal: 'Open in Terminal',
        openInEditor: 'Open in Editor',
        openInFileManager: 'Open in {manager}',
        copyPath: 'Copy Path',
        pin: 'Pin',
        unpin: 'Unpin',
        connectTo: 'Connect to...',
        renameBranch: 'Rename Branch',
        duplicate: 'Duplicate',
        unbranch: 'Unbranch',
        keepBranch: 'Keep branch',
        archive: 'Archive',
        deleteBranch: 'Delete branch',
        removeWorktree: 'Remove Worktree',
        detachedHead: 'Detached HEAD',
        connectionWorktrees: 'Connection Worktrees',
        rename: 'Rename',
        delete: 'Delete'
      },
      status: {
        archiving: 'Archiving',
        answering: 'Answer questions',
        commandApproval: 'Approve command',
        permission: 'Permission',
        planning: 'Planning',
        working: 'Working',
        planReady: 'Plan ready',
        ready: 'Ready'
      },
      toasts: {
        attachmentRemoved: 'Attachment removed',
        attachmentRemoveError: 'Failed to remove attachment',
        invalidBranchName: 'Invalid branch name',
        branchRenamed: 'Branch renamed to {branch}',
        branchRenameError: 'Failed to rename branch',
        detachedCannotDuplicate: 'Detached HEAD worktrees cannot be duplicated',
        duplicatedTo: 'Duplicated to {name}',
        newBranch: 'new branch',
        duplicateError: 'Failed to duplicate worktree',
        archiveSuccess: 'Worktree "{name}" archived and branch deleted',
        archiveError: 'Failed to archive worktree: {error}',
        unbranchSuccess: 'Worktree "{name}" removed (branch preserved)',
        removeWorktreeSuccess: 'Worktree "{name}" removed',
        unbranchError: 'Failed to unbranch worktree: {error}',
        unknownError: 'Unknown error',
        openedInTerminal: 'Opened in Terminal',
        openInTerminalError: 'Failed to open in terminal',
        openInTerminalDescription: 'Make sure the worktree directory exists',
        openedInEditor: 'Opened in Editor',
        openInEditorError: 'Failed to open in editor',
        openInEditorDescription: 'Make sure VS Code is installed',
        pathCopied: 'Path copied to clipboard'
      }
    },
    projectItem: {
      menu: {
        editName: 'Edit Name',
        openInFileManager: 'Open in {manager}',
        copyPath: 'Copy Path',
        refreshLanguage: 'Refresh Language',
        refreshProject: 'Refresh Project',
        newWorkspaceFrom: 'New Workspace From...',
        projectSettings: 'Project Settings',
        assignToSpace: 'Assign to Space',
        removeFromHive: 'Remove from Hive'
      },
      dialogs: {
        remove: {
          title: 'Remove project from Hive?',
          description: 'This will remove {name} from Hive.',
          unaffected: 'Your files on disk will not be affected.',
          cancel: 'Cancel',
          confirm: 'Remove'
        },
        noCommits: {
          title: 'Initial Commit Required',
          description:
            'Creating a first commit with the initial state is required for adding worktrees.',
          ok: 'OK'
        }
      },
      toasts: {
        renamedSuccess: 'Project renamed successfully',
        renamedError: 'Failed to rename project',
        removedSuccess: 'Project removed from Hive',
        removedError: 'Failed to remove project',
        pathCopied: 'Path copied to clipboard',
        refreshed: 'Project refreshed',
        worktreeCreated: 'Worktree "{name}" created successfully',
        createWorktreeError: 'Failed to create worktree',
        createWorktreeErrorWithReason: 'Failed to create worktree: {error}',
        createWorktreeFromBranchError: 'Failed to create worktree from branch',
        createWorktreeFromBranchErrorWithReason: 'Failed to create worktree from branch: {error}'
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
    fileTree: {
      gitStatus: {
        modified: '已修改',
        staged: '已暂存',
        deleted: '已删除',
        untracked: '未跟踪',
        conflicted: '有冲突',
        stagedSuffix: '（已暂存）'
      }
    },
    terminalToolbar: {
      status: {
        starting: '启动中...',
        terminal: '终端',
        ghostty: 'Ghostty',
        exited: '已退出（{code}）'
      },
      search: {
        placeholder: '搜索...',
        previous: '上一个匹配（Shift+Enter）',
        next: '下一个匹配（Enter）',
        close: '关闭搜索（Escape）'
      },
      actions: {
        search: '搜索（Cmd+F）',
        clear: '清空终端（Cmd+K）',
        restart: '重启终端'
      }
    },
    runOutputSearch: {
      placeholder: '在输出中查找...',
      count: '{current} / {total}',
      noResults: '没有结果',
      previous: '上一个匹配（Shift+Enter）',
      next: '下一个匹配（Enter）',
      close: '关闭（Escape）'
    },
    setupTab: {
      empty: {
        noWorktree: '选择一个 worktree 以查看 setup 输出',
        noOutput: '当前还没有 setup 输出。点击“重新运行 Setup”开始执行。',
        configure: '配置 setup 脚本'
      },
      status: {
        running: '运行中...',
        complete: 'Setup 已完成',
        failed: 'Setup 失败'
      },
      actions: {
        rerun: '重新运行 Setup'
      }
    },
    copyMessageButton: {
      ariaLabel: '复制消息',
      toasts: {
        copied: '已复制到剪贴板',
        copyError: '复制失败'
      }
    },
    codeBlock: {
      copyButton: '复制代码',
      toasts: {
        copied: '代码已复制到剪贴板',
        copyError: '复制代码失败'
      }
    },
    errorFallback: {
      title: '出了点问题',
      message: '发生了一个未预期的错误',
      retry: '重试'
    },
    updateToast: {
      available: {
        title: '发现 v{version} 更新',
        later: '稍后',
        skip: '跳过此版本',
        download: '下载'
      },
      progress: {
        title: '正在下载 v{version}...'
      }
    },
    ghosttyPromoToast: {
      title: 'Ghostty 原生终端已可用',
      description: '基于 Metal 的原生渲染，并沿用你的 Ghostty 配置',
      dismiss: '不再提示',
      activate: '启用'
    },
    compactionPill: {
      auto: '已自动压缩上下文',
      manual: '已压缩上下文'
    },
    indeterminateProgressBar: {
      asking: '等待回答中',
      working: 'Agent 正在执行'
    },
    gitCommitForm: {
      summaryPlaceholder: '提交摘要',
      descriptionPlaceholder: '补充说明（可选）',
      committing: '提交中...',
      commit: '提交',
      stagedCount: '{count} 个{label}',
      fileSingular: '文件',
      filePlural: '文件',
      conflictWarning: '请先解决合并冲突，再进行提交',
      shortcutHint: '{modifier}+Enter 提交',
      toasts: {
        success: '改动已成功提交',
        commitHash: '提交：{hash}',
        error: '提交失败'
      }
    },
    gitPushPull: {
      actions: {
        push: '推送',
        pull: '拉取',
        merge: '合并',
        archive: '归档',
        delete: '删除'
      },
      merge: {
        label: '合并来源',
        select: '选择分支',
        filterPlaceholder: '筛选分支...',
        loading: '加载中...',
        noMatching: '没有匹配的分支',
        noBranches: '没有找到分支'
      },
      toasts: {
        pushSuccess: '推送成功',
        pushError: '推送失败',
        pullSuccess: '拉取成功',
        pullError: '拉取失败',
        deleteSuccess: '已删除分支 {branch}',
        deleteError: '删除分支失败',
        mergeSuccess: '已成功合并 {branch}',
        mergeError: '合并失败'
      }
    },
    gitStatusPanel: {
      ariaLabel: 'Git 状态',
      loading: '加载中...',
      refresh: '刷新 Git 状态',
      noChanges: '没有变更',
      ahead: '领先 {count} 个提交',
      behind: '落后 {count} 个提交',
      conflictsTitle: '{count} 个文件存在合并冲突，点击可用 AI 修复',
      conflictsButton: '冲突',
      unknownBranch: '未知分支',
      conflictSessionName: '合并冲突：{branch}',
      pendingMessage: '修复合并冲突',
      sections: {
        conflicts: '冲突',
        staged: '已暂存变更',
        changes: '变更',
        untracked: '未跟踪'
      },
      actions: {
        stageAll: '全部暂存',
        stageAllTitle: '暂存所有文件',
        unstageAll: '全部取消暂存',
        unstageAllTitle: '取消暂存所有文件'
      },
      fileItem: {
        stageFile: '暂存 {path}',
        unstageFile: '取消暂存 {path}',
        viewChanges: '查看变更',
        viewChangesTitle: '查看变更：{path}'
      },
      toasts: {
        stageAllSuccess: '已暂存所有变更',
        stageAllError: '暂存变更失败',
        unstageAllSuccess: '已取消暂存所有变更',
        unstageAllError: '取消暂存变更失败',
        stageFileError: '暂存 {path} 失败',
        unstageFileError: '取消暂存 {path} 失败',
        noWorktreeSelected: '未选择 worktree',
        projectNotFound: '找不到该 worktree 对应的项目',
        createSessionError: '创建会话失败',
        conflictResolutionError: '启动冲突修复失败'
      }
    },
    projectList: {
      error: {
        title: '加载项目失败'
      },
      empty: {
        noProjects: '还没有添加任何项目。',
        addProjectHint: '点击 + 添加一个项目。',
        noProjectsInSpace: '这个空间里还没有项目。',
        assignHint: '右键项目即可将其分配到当前空间。',
        noMatches: '没有匹配的项目'
      }
    },
    terminalManager: {
      empty: {
        selectWorktree: '选择一个 worktree 以打开终端'
      }
    },
    appLayout: {
      sidebarError: '侧边栏错误',
      drop: {
        noSession: '请先打开一个会话再附加文件',
        noFolders: '不能附加文件夹。请改为拖入单个文件。',
        maxFiles: '单次最多拖入 {count} 个文件',
        readError: '读取一个或多个拖入文件失败'
      }
    },
    loading: {
      default: '加载中...'
    },
    connectionList: {
      title: '连接'
    },
    prReview: {
      viewer: {
        loading: '正在加载审查评论...',
        retry: '重试',
        empty: '这个 PR 还没有审查评论',
        refresh: '刷新评论',
        allHidden: '所有评论都已被筛选器隐藏',
        selectedCount: '已选择 {count} 条',
        selectAll: '全选',
        deselect: '取消选择',
        addToChat: '添加到聊天',
        reviewer: {
          show: '显示 {login} 的评论',
          hide: '隐藏 {login} 的评论'
        }
      },
      store: {
        fetchError: '获取评论失败',
        unknownReviewer: '未知评论者',
        unknownPath: '未知文件'
      },
      commentCard: {
        copied: '已复制原始评论 HTML',
        outdated: '旧',
        copyRawHtml: '复制原始 HTML'
      }
    },
    toolViews: {
      common: {
        showLess: '收起',
        showAllLines: '显示全部 {count} 行'
      },
      grep: {
        in: '在',
        matchCount: '{count} 个{label}',
        matchSingular: '匹配',
        matchPlural: '匹配',
        noMatches: '未找到匹配结果',
        showAllResults: '显示全部 {count} 条结果'
      },
      read: {
        linesRange: '第 {start}-{end} 行',
        fromLine: '从第 {start} 行开始',
        firstLines: '前 {count} 行'
      },
      fileChange: {
        add: '新增',
        delete: '删除',
        update: '更新',
        moreLines: '... 还有 {count} 行',
        noDiffContent: '没有 diff 内容',
        noChanges: '没有文件变更'
      },
      edit: {
        lineCount: '{count} {label}',
        lineSingular: '行',
        linePlural: '行',
        moreRemoved: '... 还有 {count} 行被移除',
        moreAdded: '... 还有 {count} 行被新增',
        noChanges: '没有变更'
      },
      fallback: {
        todo: '待完善',
        error: '错误',
        input: '输入',
        output: '输出',
        note: '暂无自定义渲染器，当前显示原始数据'
      },
      skill: {
        loading: '正在加载技能内容...'
      },
      exitPlan: {
        empty: '没有可用的计划内容。'
      },
      todo: {
        empty: '没有任务'
      },
      webFetch: {
        bytesSingular: '{count} 字节',
        bytesPlural: '{count} 字节',
        kb: '{value} KB',
        mb: '{value} MB'
      },
      lsp: {
        noHover: '没有悬停信息',
        noResults: '没有结果',
        noDiagnostics: '没有诊断信息',
        unknown: '未知',
        showAll: '显示全部 {count} 条{label}',
        labels: {
          locations: '位置',
          calls: '调用',
          symbols: '符号',
          diagnostics: '诊断'
        },
        operations: {
          definition: '定义',
          hover: '悬停',
          references: '引用',
          symbols: '符号',
          workspaceSymbols: '工作区符号',
          implementation: '实现',
          callers: '调用方',
          callees: '被调用方',
          diagnostics: '诊断'
        },
        symbolKinds: {
          file: '文件',
          module: '模块',
          namespace: '命名空间',
          package: '包',
          class: '类',
          method: '方法',
          property: '属性',
          field: '字段',
          constructor: '构造函数',
          enum: '枚举',
          interface: '接口',
          function: '函数',
          variable: '变量',
          constant: '常量',
          string: '字符串',
          number: '数字',
          boolean: '布尔值',
          array: '数组',
          object: '对象',
          key: '键',
          null: '空值',
          enumMember: '枚举成员',
          struct: '结构体',
          event: '事件',
          operator: '运算符',
          typeParam: '类型参数'
        }
      },
      task: {
        defaultTitle: '子代理',
        prompt: '提示词'
      }
    },
    contextIndicator: {
      title: '上下文窗口',
      summary: {
        withLimit: '{used} / {limit} tokens ({percent}%)',
        noLimit: '{used} tokens（无法获取上限）'
      },
      labels: {
        input: '输入',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入'
      },
      generated: {
        title: '生成内容（不计入上下文）',
        output: '输出',
        reasoning: '推理'
      },
      cost: {
        session: '会话成本：{cost}'
      }
    },
    helpOverlay: {
      title: '键盘快捷键',
      mode: {
        normal: '普通',
        insert: '插入'
      },
      sections: {
        vimNavigation: 'Vim 导航',
        panelShortcuts: '面板快捷键',
        actionShortcuts: '操作快捷键',
        sidebarHints: '侧边栏提示',
        sessionHints: '会话提示',
        systemShortcuts: '系统快捷键'
      },
      rows: {
        navigateWorktrees: '在 worktree 之间导航',
        navigateSessionTabs: '在会话标签之间导航',
        filterProjectsInsert: '筛选项目（进入插入模式）',
        returnToNormalMode: '返回普通模式',
        toggleHelp: '切换此帮助面板',
        prevNextFileTab: '上一个 / 下一个文件标签'
      },
      panels: {
        changes: '变更',
        files: '文件',
        diffs: '差异',
        setup: '设置',
        run: '运行',
        terminal: '终端'
      },
      actions: {
        review: '审查',
        pr: 'PR',
        mergePr: '合并 PR',
        archive: '归档'
      },
      dynamic: {
        pinnedPrefix: '[固定] {name}',
        connectionFallback: '连接'
      }
    },
    keyboardShortcuts: {
      items: {
        sessionNew: '新建会话',
        sessionClose: '关闭会话',
        sessionModeToggle: '切换 Build / Plan 模式',
        projectRun: '运行项目',
        modelCycleVariant: '切换模型变体',
        navFileSearch: '搜索文件',
        navCommandPalette: '打开命令面板',
        navSessionHistory: '打开会话历史',
        navNewWorktree: '新建 worktree',
        gitCommit: '聚焦提交表单',
        gitPush: '推送到远端',
        gitPull: '从远端拉取',
        navFilterProjects: '筛选项目',
        sidebarToggleLeft: '切换左侧边栏',
        sidebarToggleRight: '切换右侧边栏',
        focusLeftSidebar: '聚焦左侧边栏',
        focusMainPane: '聚焦主面板',
        settingsOpen: '打开设置'
      }
    },
    connectionStore: {
      toasts: {
        unknownError: '未知错误',
        createError: '创建连接失败：{error}',
        createSuccess: '连接“{name}”已创建',
        deleteError: '删除连接失败',
        deleteErrorWithReason: '删除连接失败：{error}',
        deleteSuccess: '连接已删除',
        addMemberError: '添加成员失败：{error}',
        removeMemberError: '移除成员失败：{error}',
        notFound: '未找到连接',
        updateSuccess: '连接已更新',
        updateError: '更新连接失败：{error}',
        renameError: '重命名连接失败',
        renameErrorWithReason: '重命名连接失败：{error}'
      }
    },
    pinnedStore: {
      toasts: {
        pinConnectionError: '固定连接失败',
        unpinConnectionError: '取消固定连接失败'
      }
    },
    sessionStore: {
      errors: {
        createConnectionSession: '创建连接会话失败'
      }
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
      filterPopover: {
        noMatchingCommands: '没有匹配的命令',
        noMatchingLanguages: '没有匹配的语言'
      },
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
        commandApproval: '审批命令',
        permission: '等待授权',
        planning: '规划中',
        working: '执行中',
        planReady: '计划已就绪',
        ready: '就绪'
      }
    },
    dialogs: {
      archiveConfirm: {
        title: '存在未提交变更',
        description: '{worktreeName} 中有未提交的变更，继续后这些变更将被永久丢失。',
        binary: '二进制',
        noChanges: '无变更',
        moreFiles: '另有 {count} 个{label}',
        fileSingular: '文件',
        filePlural: '文件',
        cancel: '取消',
        confirm: '仍然归档'
      },
      gitInit: {
        title: '不是 Git 仓库',
        selectedFolder: '所选文件夹不是 Git 仓库：',
        question: '要为它初始化一个新的 Git 仓库吗？',
        cancel: '取消',
        confirm: '初始化仓库'
      },
      connect: {
        title: '连接 Worktree',
        description: '选择其他项目中的 worktree，将它们连接到同一个共享工作区。',
        existingConnections: '已有连接',
        addToExisting: '加入已有连接',
        filterPlaceholder: '筛选 worktree...',
        noWorktrees: '当前没有来自其他项目的 worktree 可供连接。',
        noWorktreesHint: '请先向 Hive 添加另一个项目。',
        noMatches: '没有匹配筛选条件的 worktree',
        selectedCount: '已选择 {count} 个{label}',
        selectedNone: '请选择要连接的 worktree',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktree',
        connect: '连接',
        connecting: '连接中...'
      },
      manageConnectionWorktrees: {
        title: '连接中的 Worktree',
        description: '管理这个连接中包含哪些 worktree。',
        filterPlaceholder: '筛选 worktree...',
        noWorktrees: '没有找到活跃的 worktree。',
        noMatches: '没有匹配筛选条件的 worktree',
        selectedNone: '至少选择 1 个 worktree',
        selectedCount: '已选择 {count} 个{label}',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktree',
        save: '保存',
        saving: '保存中...'
      },
      addAttachment: {
        title: '添加附件',
        placeholder: '粘贴 Jira 或 Figma 链接',
        detected: {
          jira: 'Jira 工单',
          figma: 'Figma 文件'
        },
        unsupportedUrl: '不支持的链接',
        confirm: '添加',
        toasts: {
          added: '已附加{type}：{label}',
          addError: '添加附件失败'
        }
      },
      projectSettings: {
        title: '项目设置',
        icon: {
          label: '项目图标',
          description: '显示在侧边栏中的自定义图标，支持 SVG、PNG、JPG 和 WebP。',
          change: '更换',
          changing: '选择中...',
          clear: '清除',
          pickError: '选择图标失败',
          removeError: '移除图标失败'
        },
        autoAssignPort: {
          label: '自动分配端口',
          description:
            '为每个 worktree 分配唯一端口，并将 PORT 注入 run/setup 脚本。端口从 3011 开始。'
        },
        setupScript: {
          label: 'Setup 脚本',
          description: '初始化新 worktree 时运行的命令。每一行都会作为独立命令执行。',
          placeholder: 'pnpm install\npnpm run build'
        },
        runScript: {
          label: 'Run 脚本',
          description: '按下 ⌘R 时触发的命令。运行中再次按 ⌘R 会停止。',
          placeholder: 'pnpm run dev'
        },
        archiveScript: {
          label: 'Archive 脚本',
          description: '归档 worktree 前运行的命令。即使失败也不会阻止归档。',
          placeholder: 'pnpm run clean'
        },
        cancel: '取消',
        save: '保存',
        saving: '保存中...',
        saveSuccess: '项目设置已保存',
        saveError: '保存项目设置失败'
      },
      branchPicker: {
        title: '新建工作区',
        description: '选择一个分支或 PR，以此创建新的工作区。',
        tabs: {
          branches: '分支',
          prs: 'PR'
        },
        filterBranches: '筛选分支...',
        filterPRs: '筛选 PR...',
        loadingBranches: '正在加载分支...',
        noBranchesMatch: '没有匹配筛选条件的分支',
        noBranches: '没有找到分支',
        remote: '远端',
        active: '已激活',
        loadingPRs: '正在加载 PR...',
        noPRsMatch: '没有匹配筛选条件的 PR',
        noPRs: '没有打开的 PR',
        branchCount: '{count} 个{label}{match}',
        prCount: '{count} 个{label}{match}',
        branchSingular: '分支',
        branchPlural: '分支',
        prSingular: 'PR',
        prPlural: 'PR',
        matching: '，匹配 “{query}”'
      }
    },
    header: {
      controls: {
        fixConflicts: '修复冲突',
        fixingConflicts: '正在修复冲突...',
        archiveWorktreeTitle: '归档 worktree',
        archive: '归档',
        archiving: '归档中...',
        mergePRTitle: '合并 Pull Request',
        mergePR: '合并 PR',
        merging: '合并中...',
        reviewTitle: '用 AI 审查分支改动',
        review: '审查',
        noRemoteBranches: '没有远端分支',
        attached: '已关联',
        loadingPRs: '正在加载 PR...',
        noOpenPRs: '没有打开的 PR',
        detachPR: '解除 PR 关联',
        createPRTitle: '创建 Pull Request（右键可关联已有 PR）',
        attachExistingPR: '关联已有 PR',
        sessionHistoryTitle: '会话历史（⌘K）',
        settingsTitle: '设置（⌘,）',
        showSidebar: '显示侧边栏',
        hideSidebar: '隐藏侧边栏',
        merged: '已合并',
        closed: '已关闭'
      }
    },
    pinned: {
      title: '已固定',
      connectionFallback: '连接',
      connectionNamePlaceholder: '连接名称',
      menu: {
        open: '打开',
        detach: '解除关联',
        addAttachment: '添加附件',
        editContext: '编辑上下文',
        openInTerminal: '在终端中打开',
        openInEditor: '在编辑器中打开',
        openInFileManager: '在 {manager} 中打开',
        copyPath: '复制路径',
        pin: '固定',
        unpin: '取消固定',
        connectTo: '连接到...',
        renameBranch: '重命名分支',
        duplicate: '复制',
        unbranch: '移除 worktree',
        keepBranch: '保留分支',
        archive: '归档',
        deleteBranch: '删除分支',
        removeWorktree: '移除 worktree',
        detachedHead: 'Detached HEAD',
        connectionWorktrees: '连接中的 Worktree',
        rename: '重命名',
        delete: '删除'
      },
      status: {
        archiving: '归档中',
        answering: '等待回答',
        commandApproval: '审批命令',
        permission: '等待授权',
        planning: '规划中',
        working: '执行中',
        planReady: '计划已就绪',
        ready: '就绪'
      },
      toasts: {
        attachmentRemoved: '附件已移除',
        attachmentRemoveError: '移除附件失败',
        invalidBranchName: '分支名称无效',
        branchRenamed: '分支已重命名为 {branch}',
        branchRenameError: '分支重命名失败',
        detachedCannotDuplicate: 'Detached HEAD 状态下的 worktree 不能复制',
        duplicatedTo: '已复制到 {name}',
        newBranch: '新分支',
        duplicateError: '复制 worktree 失败',
        archiveSuccess: 'Worktree “{name}” 已归档并删除分支',
        archiveError: '归档 worktree 失败：{error}',
        unbranchSuccess: 'Worktree “{name}” 已移除（保留分支）',
        removeWorktreeSuccess: 'Worktree “{name}” 已移除',
        unbranchError: '移除 worktree 失败：{error}',
        unknownError: '未知错误',
        openedInTerminal: '已在终端中打开',
        openInTerminalError: '在终端中打开失败',
        openInTerminalDescription: '请确认 worktree 目录存在',
        openedInEditor: '已在编辑器中打开',
        openInEditorError: '在编辑器中打开失败',
        openInEditorDescription: '请确认 VS Code 已安装',
        pathCopied: '路径已复制到剪贴板'
      }
    },
    projectItem: {
      menu: {
        editName: '编辑名称',
        openInFileManager: '在 {manager} 中打开',
        copyPath: '复制路径',
        refreshLanguage: '刷新语言识别',
        refreshProject: '刷新项目',
        newWorkspaceFrom: '从分支创建工作区...',
        projectSettings: '项目设置',
        assignToSpace: '分配到空间',
        removeFromHive: '从 Hive 中移除'
      },
      dialogs: {
        remove: {
          title: '要从 Hive 中移除这个项目吗？',
          description: '这会把 {name} 从 Hive 中移除。',
          unaffected: '磁盘上的文件不会受到影响。',
          cancel: '取消',
          confirm: '移除'
        },
        noCommits: {
          title: '需要先提交初始版本',
          description: '要创建 worktree，必须先创建一次初始提交。',
          ok: '好的'
        }
      },
      toasts: {
        renamedSuccess: '项目重命名成功',
        renamedError: '项目重命名失败',
        removedSuccess: '项目已从 Hive 中移除',
        removedError: '移除项目失败',
        pathCopied: '路径已复制到剪贴板',
        refreshed: '项目已刷新',
        worktreeCreated: 'Worktree “{name}” 创建成功',
        createWorktreeError: '创建 worktree 失败',
        createWorktreeErrorWithReason: '创建 worktree 失败：{error}',
        createWorktreeFromBranchError: '从分支创建 worktree 失败',
        createWorktreeFromBranchErrorWithReason: '从分支创建 worktree 失败：{error}'
      }
    }
  }
}
