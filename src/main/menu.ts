import { BrowserWindow, Menu, app, shell } from 'electron'
import { getLogDir } from './services/logger'

export interface MenuState {
  hasActiveSession: boolean
  hasActiveWorktree: boolean
}

let _mainWindow: BrowserWindow | null = null

function send(channel: string): void {
  _mainWindow?.webContents.send(channel)
}

const sessionItemIds = [
  'session-toggle-mode',
  'session-cycle-model',
  'session-undo-turn',
  'session-redo-turn'
]

const worktreeItemIds = [
  'session-run-project',
  'git-commit',
  'git-push',
  'git-pull',
  'git-stage-all',
  'git-unstage-all',
  'git-open-in-editor',
  'git-open-in-terminal'
]

export function buildMenu(mainWindow: BrowserWindow, isDev: boolean): Menu {
  _mainWindow = mainWindow

  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // Hive (appMenu) — macOS only
    ...(isMac ? [{ role: 'appMenu' as const }] : []),

    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('shortcut:new-session')
        },
        {
          label: 'Close Session',
          accelerator: 'CmdOrCtrl+W',
          click: () => send('shortcut:close-session')
        },
        { type: 'separator' },
        {
          label: 'New Worktree...',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => send('menu:new-worktree')
        },
        { type: 'separator' },
        {
          label: 'Add Project...',
          click: () => send('menu:add-project')
        },
        { type: 'separator' },
        ...(!isMac ? [{ role: 'quit' as const }] : [])
      ]
    },

    // Edit
    { role: 'editMenu' },

    // Session
    {
      label: 'Session',
      submenu: [
        {
          id: 'session-toggle-mode',
          label: 'Toggle Build / Plan Mode',
          enabled: false,
          click: () => send('menu:toggle-mode')
        },
        {
          id: 'session-cycle-model',
          label: 'Cycle Model Variant',
          accelerator: 'Alt+T',
          enabled: false,
          click: () => send('menu:cycle-model')
        },
        { type: 'separator' },
        {
          id: 'session-run-project',
          label: 'Run Project',
          accelerator: 'CmdOrCtrl+R',
          enabled: false,
          click: () => send('menu:run-project')
        },
        { type: 'separator' },
        {
          id: 'session-undo-turn',
          label: 'Undo Turn',
          enabled: false,
          click: () => send('menu:undo-turn')
        },
        {
          id: 'session-redo-turn',
          label: 'Redo Turn',
          enabled: false,
          click: () => send('menu:redo-turn')
        }
      ]
    },

    // Git
    {
      label: 'Git',
      submenu: [
        {
          id: 'git-commit',
          label: 'Commit...',
          accelerator: 'CmdOrCtrl+Shift+C',
          enabled: false,
          click: () => send('menu:commit')
        },
        {
          id: 'git-push',
          label: 'Push',
          accelerator: 'CmdOrCtrl+Shift+P',
          enabled: false,
          click: () => send('menu:push')
        },
        {
          id: 'git-pull',
          label: 'Pull',
          accelerator: 'CmdOrCtrl+Shift+L',
          enabled: false,
          click: () => send('menu:pull')
        },
        { type: 'separator' },
        {
          id: 'git-stage-all',
          label: 'Stage All',
          enabled: false,
          click: () => send('menu:stage-all')
        },
        {
          id: 'git-unstage-all',
          label: 'Unstage All',
          enabled: false,
          click: () => send('menu:unstage-all')
        },
        { type: 'separator' },
        {
          id: 'git-open-in-editor',
          label: 'Open in Editor',
          enabled: false,
          click: () => send('menu:open-in-editor')
        },
        {
          id: 'git-open-in-terminal',
          label: 'Open in Terminal',
          enabled: false,
          click: () => send('menu:open-in-terminal')
        }
      ]
    },

    // View
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+P',
          click: () => send('menu:command-palette')
        },
        {
          label: 'Search Files',
          accelerator: 'CmdOrCtrl+D',
          click: () => send('shortcut:file-search')
        },
        {
          label: 'Session History',
          accelerator: 'CmdOrCtrl+K',
          click: () => send('menu:session-history')
        },
        { type: 'separator' },
        {
          label: 'Toggle Left Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('menu:toggle-left-sidebar')
        },
        {
          label: 'Toggle Right Sidebar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => send('menu:toggle-right-sidebar')
        },
        { type: 'separator' },
        {
          label: 'Focus Left Sidebar',
          accelerator: 'CmdOrCtrl+1',
          click: () => send('menu:focus-left-sidebar')
        },
        {
          label: 'Focus Main Pane',
          accelerator: 'CmdOrCtrl+2',
          click: () => send('menu:focus-main-pane')
        },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : [])
      ]
    },

    // Window
    { role: 'windowMenu' },

    // Help
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Log Directory',
          click: () => {
            shell.openPath(getLogDir())
          }
        },
        { type: 'separator' },
        {
          id: 'help-app-version',
          label: `Version ${app.getVersion()}`,
          enabled: false
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}

export function updateMenuState(state: MenuState): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return

  for (const id of sessionItemIds) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = state.hasActiveSession
  }

  for (const id of worktreeItemIds) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = state.hasActiveWorktree
  }
}

export function setAppVersion(version: string): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return

  const item = menu.getMenuItemById('help-app-version')
  if (item) item.label = `Version ${version}`
}
