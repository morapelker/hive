// The console log's keyboard shortcut: ⌃⌘C on macOS (TablePlus' console key; ⇧⌘C is taken
// by the app menu), Ctrl+Alt+C elsewhere (Ctrl+Meta is the Windows key there).

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const CONSOLE_SHORTCUT_LABEL = isMacPlatform() ? '⌃⌘C' : 'Ctrl+Alt+C'

export const isConsoleShortcut = (event: KeyboardEvent): boolean =>
  (isMacPlatform()
    ? event.ctrlKey && event.metaKey && !event.altKey
    : event.ctrlKey && event.altKey && !event.metaKey) &&
  !event.shiftKey &&
  (event.code === 'KeyC' || event.key.toLowerCase() === 'c')
