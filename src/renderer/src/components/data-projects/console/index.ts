// The Console tab of the SQL and Mongo workspaces (TablePlus' Console log): the panel, its
// store (entries per project + the metadata toggle) and the pure formatting helpers.
export { ConsolePanel, type ConsolePanelProps } from './ConsolePanel'
export {
  followDataConsole,
  mergeConsoleEntries,
  useDataConsoleStore,
  type ConsoleProjectLog
} from './console-store'
export {
  CONSOLE_SOURCE_LABEL,
  consoleEntryBlock,
  consoleLogText,
  consoleOpenBlocker,
  matchesConsoleFilter
} from './console-format'
export { CONSOLE_SHORTCUT_LABEL, isConsoleShortcut } from './console-shortcut'
