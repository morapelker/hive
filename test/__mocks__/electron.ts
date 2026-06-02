// Mock electron module for Node.js test environment
// Only the `app` export is needed by database.ts (for getPath)
export const app = {
  getPath: (name: string): string => {
    if (name === 'home') return '/tmp/hive-test-mock-home'
    return `/tmp/hive-test-mock-${name}`
  },
  getVersion: (): string => '1.1.10',
  isPackaged: false,
  quit: (): void => {}
}

export const clipboard = {
  readText: (): string => '',
  writeText: (_text: string): void => {}
}

export const shell = {
  openExternal: async (_url: string): Promise<void> => {},
  openPath: async (_path: string): Promise<string> => '',
  showItemInFolder: (_path: string): void => {}
}

export const dialog = {
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 }),
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: true
  })
}

let browserWindows: unknown[] = []

export const BrowserWindow = {
  getAllWindows: (): unknown[] => browserWindows,
  getFocusedWindow: (): unknown | null => null
}

export const __setBrowserWindows = (windows: unknown[]): void => {
  browserWindows = windows
}
