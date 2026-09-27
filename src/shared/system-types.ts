export interface SystemAppPaths {
  readonly userData: string
  readonly home: string
  readonly logs: string
}

/**
 * System Settings › Privacy & Security panes the app can open for the user.
 * `fullDiskAccess` is the one grant that silences every folder-access prompt;
 * `filesAndFolders` lists the per-folder answers already given.
 */
export const MACOS_PRIVACY_PANES = ['fullDiskAccess', 'filesAndFolders'] as const

export type MacosPrivacyPane = (typeof MACOS_PRIVACY_PANES)[number]

export interface MacosPermissionStatus {
  /** True on macOS, where the privacy (TCC) prompts exist. False elsewhere. */
  readonly supported: boolean
  /** Whether the app currently holds Full Disk Access. Always false when unsupported. */
  readonly fullDiskAccess: boolean
}

export interface OpenMacosPrivacySettingsResult {
  readonly success: boolean
  readonly error?: string
}
