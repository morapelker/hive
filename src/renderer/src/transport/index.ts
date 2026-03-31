import { detectTransportMode } from './detect'
import { getWebAuth } from './graphql/auth'
import { initGraphQLClient } from './graphql/client'
import { createDbAdapter } from './graphql/adapters/db'
import { createOpenCodeOpsAdapter } from './graphql/adapters/opencode-ops'
import { createGitOpsAdapter } from './graphql/adapters/git-ops'
import { createFileTreeOpsAdapter } from './graphql/adapters/file-tree-ops'
import { createTerminalOpsAdapter } from './graphql/adapters/terminal-ops'
import { createWorktreeOpsAdapter } from './graphql/adapters/worktree-ops'
import { createProjectOpsAdapter } from './graphql/adapters/project-ops'
import { createConnectionOpsAdapter } from './graphql/adapters/connection-ops'
import { createSystemOpsAdapter } from './graphql/adapters/system-ops'
import { createSettingsOpsAdapter } from './graphql/adapters/settings-ops'
import { createFileOpsAdapter } from './graphql/adapters/file-ops'
import { createScriptOpsAdapter } from './graphql/adapters/script-ops'
import { createLoggingOpsAdapter } from './graphql/adapters/logging-ops'
import { createUpdaterOpsAdapter } from './graphql/adapters/updater-ops'
import { createUsageOpsAdapter } from './graphql/adapters/usage-ops'
import { createAnalyticsOpsAdapter } from './graphql/adapters/analytics-ops'
import { createKanbanAdapter } from './graphql/adapters/kanban'
import { createTicketImportAdapter } from './graphql/adapters/ticket-import'

export interface TransportResult {
  mode: 'electron' | 'web'
  needsAuth: boolean
}

export function installTransport(): TransportResult {
  const mode = detectTransportMode()
  if (mode === 'electron') return { mode, needsAuth: false }

  const auth = getWebAuth()
  if (!auth) return { mode, needsAuth: true }

  // Derive WebSocket URL from HTTP URL
  const wsUrl = auth.serverUrl.replace(/^http/, 'ws') + '/graphql'
  const httpUrl = auth.serverUrl + '/graphql'

  initGraphQLClient({ httpUrl, wsUrl, apiKey: auth.apiKey })

  // Install core adapters
  window.db = createDbAdapter()
  window.opencodeOps = createOpenCodeOpsAdapter()
  window.gitOps = createGitOpsAdapter()
  window.fileTreeOps = createFileTreeOpsAdapter()
  window.terminalOps = createTerminalOpsAdapter()
  window.worktreeOps = createWorktreeOpsAdapter()
  window.projectOps = createProjectOpsAdapter()
  window.connectionOps = createConnectionOpsAdapter()
  window.systemOps = createSystemOpsAdapter()
  window.settingsOps = createSettingsOpsAdapter()
  window.fileOps = createFileOpsAdapter()
  window.scriptOps = createScriptOpsAdapter()
  window.loggingOps = createLoggingOpsAdapter()
  window.updaterOps = createUpdaterOpsAdapter()
  window.usageOps = createUsageOpsAdapter()
  window.analyticsOps = createAnalyticsOpsAdapter()
  window.kanban = createKanbanAdapter()
  window.ticketImport = createTicketImportAdapter()

  return { mode, needsAuth: false }
}
