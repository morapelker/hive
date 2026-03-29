# Import Tickets from External Platforms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-agnostic ticket import system that pulls issues from external platforms (starting with GitHub Issues) into Hive's kanban board, with on-demand remote status updates.

**Architecture:** A `TicketProvider` interface defines what each platform must implement (list issues, import issue, get/update statuses, settings schema). A `TicketProviderManager` singleton (mirroring `AgentSdkManager`) registers providers. GitHub is the v1 provider, authenticating via `gh` CLI token or user-provided PAT. The shared service layer is exposed through both IPC handlers (Electron) and GraphQL resolvers (headless mode). The renderer gets a browse-and-select modal on the kanban board and a status-push context menu on imported ticket cards.

**Tech Stack:** TypeScript, Electron IPC, GraphQL (graphql-yoga), SQLite (better-sqlite3), React, Zustand, shadcn/ui, GitHub REST API via `gh` CLI / `fetch`.

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/main/services/ticket-providers/ticket-provider-types.ts` | `TicketProvider` interface, shared types (`RemoteIssue`, `RemoteStatus`, `SettingsField`, `TicketProviderId`) |
| `src/main/services/ticket-providers/ticket-provider-manager.ts` | Singleton registry — register, get, list providers |
| `src/main/services/ticket-providers/github-provider.ts` | GitHub Issues implementation — auth (gh CLI + PAT), list/import/status via GitHub REST API |
| `src/main/ipc/ticket-import-handlers.ts` | IPC handler registrations for all ticket-import operations |
| `src/server/schema/types/ticket-import.graphql` | GraphQL types for ticket import (RemoteIssue, RemoteStatus, TicketProviderInfo) |
| `src/server/resolvers/query/ticket-import.resolvers.ts` | GraphQL query resolvers (listProviders, listRemoteIssues, getAvailableStatuses, detectRepo) |
| `src/server/resolvers/mutation/ticket-import.resolvers.ts` | GraphQL mutation resolvers (importTickets, updateRemoteStatus, saveProviderSettings) |
| `src/renderer/src/transport/graphql/adapters/ticket-import.ts` | GraphQL transport adapter for headless/web mode |
| `src/renderer/src/components/kanban/ImportTicketsModal.tsx` | Browse + select modal for importing issues |
| `src/renderer/src/components/kanban/UpdateStatusModal.tsx` | Status picker modal for pushing status to remote |
| `src/renderer/src/components/settings/SettingsIntegrations.tsx` | Integrations settings section with dynamic provider fields |

### Modified files
| File | What changes |
|------|-------------|
| `src/main/db/schema.ts` | Migration v15: add `external_provider`, `external_id`, `external_url` columns to `kanban_tickets` |
| `src/main/db/types.ts` | Add `external_provider`, `external_id`, `external_url` to `KanbanTicket`, `KanbanTicketCreate`, `KanbanTicketUpdate` |
| `src/main/db/database.ts` | Update `mapKanbanTicketRow`, `createKanbanTicket`, `updateKanbanTicket` + add `getKanbanTicketByExternalId` method |
| `src/main/index.ts` | Call `registerTicketImportHandlers()` |
| `src/preload/index.ts` | Add `ticketImport` bridge object |
| `src/preload/index.d.ts` | Add `ticketImport` to Window interface |
| `src/server/resolvers/index.ts` | Import and merge ticket-import resolvers |
| `src/server/schema/schema.graphql` | Add ticket-import queries and mutations |
| `src/renderer/src/transport/types.ts` | Export `TicketImportApi` type |
| `src/renderer/src/stores/useKanbanStore.ts` | Add `importTickets` action |
| `src/renderer/src/components/kanban/KanbanBoard.tsx` | Add Import button in board header |
| `src/renderer/src/components/kanban/KanbanTicketCard.tsx` | Add provider badge + "Update on GitHub" context menu item |
| `src/renderer/src/components/settings/SettingsModal.tsx` | Add Integrations section to SECTIONS array |

---

## Task 1: Provider Interface & Types

**Files:**
- Create: `src/main/services/ticket-providers/ticket-provider-types.ts`

- [ ] **Step 1: Create the provider types file**

```typescript
// src/main/services/ticket-providers/ticket-provider-types.ts

export type TicketProviderId = 'github'

export interface SettingsField {
  key: string
  label: string
  type: 'string' | 'password'
  required: boolean
  placeholder?: string
}

export interface RemoteIssue {
  externalId: string
  title: string
  body: string | null
  state: 'open' | 'closed'
  url: string
  createdAt: string
  updatedAt: string
}

export interface RemoteIssueListResult {
  issues: RemoteIssue[]
  hasNextPage: boolean
  totalCount: number
}

export interface RemoteStatus {
  id: string
  label: string
}

export interface TicketProvider {
  readonly id: TicketProviderId
  readonly name: string
  readonly icon: string // lucide icon name, e.g. 'github'

  /**
   * Returns settings fields this provider needs (e.g., PAT token).
   * The UI renders these dynamically in the Integrations settings section.
   */
  getSettingsSchema(): SettingsField[]

  /**
   * Test whether the provider can authenticate with the given settings.
   * Returns a descriptive error string on failure, null on success.
   */
  authenticate(settings: Record<string, string>): Promise<string | null>

  /**
   * Auto-detect the repository from a local project path.
   * Returns "owner/repo" string or null if detection fails.
   */
  detectRepo(projectPath: string): Promise<string | null>

  /**
   * List issues for a given repository. Supports pagination and search.
   */
  listIssues(
    repo: string,
    options: {
      page: number
      perPage: number
      state: 'open' | 'closed' | 'all'
      search?: string
    },
    settings: Record<string, string>
  ): Promise<RemoteIssueListResult>

  /**
   * Get the available statuses/transitions for a remote issue.
   */
  getAvailableStatuses(
    repo: string,
    externalId: string,
    settings: Record<string, string>
  ): Promise<RemoteStatus[]>

  /**
   * Update the status of a remote issue.
   */
  updateRemoteStatus(
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error?: string }>
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npx tsc --noEmit src/main/services/ticket-providers/ticket-provider-types.ts 2>&1 | head -20`

If there are path resolution issues, just verify no syntax errors with:
Run: `npx tsc --noEmit --moduleResolution node --module esnext --target esnext src/main/services/ticket-providers/ticket-provider-types.ts 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ticket-providers/ticket-provider-types.ts
git commit -m "feat(ticket-import): add TicketProvider interface and shared types"
```

---

## Task 2: TicketProviderManager Singleton

**Files:**
- Create: `src/main/services/ticket-providers/ticket-provider-manager.ts`

- [ ] **Step 1: Create the manager class**

Mirror the `AgentSdkManager` pattern from `src/main/services/agent-sdk-manager.ts`:

```typescript
// src/main/services/ticket-providers/ticket-provider-manager.ts

import type { TicketProviderId, TicketProvider } from './ticket-provider-types'
import { createLogger } from '../logger'

const log = createLogger({ component: 'TicketProviderManager' })

export class TicketProviderManager {
  private providers: Map<TicketProviderId, TicketProvider>

  constructor(providers: TicketProvider[]) {
    this.providers = new Map(providers.map((p) => [p.id, p]))
    log.info('TicketProviderManager initialized', {
      providers: Array.from(this.providers.keys())
    })
  }

  getProvider(id: TicketProviderId): TicketProvider {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error(`Unknown ticket provider: "${id}"`)
    }
    return provider
  }

  listProviders(): TicketProvider[] {
    return Array.from(this.providers.values())
  }

  hasProvider(id: TicketProviderId): boolean {
    return this.providers.has(id)
  }
}

let _instance: TicketProviderManager | null = null

export function initTicketProviderManager(providers: TicketProvider[]): TicketProviderManager {
  _instance = new TicketProviderManager(providers)
  return _instance
}

export function getTicketProviderManager(): TicketProviderManager {
  if (!_instance) {
    throw new Error('TicketProviderManager not initialized. Call initTicketProviderManager() first.')
  }
  return _instance
}
```

- [ ] **Step 2: Create barrel export**

```typescript
// src/main/services/ticket-providers/index.ts

export { TicketProviderManager, initTicketProviderManager, getTicketProviderManager } from './ticket-provider-manager'
export type {
  TicketProviderId,
  TicketProvider,
  SettingsField,
  RemoteIssue,
  RemoteIssueListResult,
  RemoteStatus
} from './ticket-provider-types'
```

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ticket-providers/ticket-provider-manager.ts src/main/services/ticket-providers/index.ts
git commit -m "feat(ticket-import): add TicketProviderManager singleton registry"
```

---

## Task 3: Database Migration v15

**Files:**
- Modify: `src/main/db/schema.ts` (add migration v15 to the `migrations` array)

- [ ] **Step 1: Add migration v15**

In `src/main/db/schema.ts`, find the last migration entry (version 14, near line 361) and add migration v15 before the closing `]` of the `migrations` array:

```typescript
  {
    version: 15,
    name: 'add_kanban_ticket_external_source',
    up: `
      ALTER TABLE kanban_tickets ADD COLUMN external_provider TEXT DEFAULT NULL;
      ALTER TABLE kanban_tickets ADD COLUMN external_id TEXT DEFAULT NULL;
      ALTER TABLE kanban_tickets ADD COLUMN external_url TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_external
        ON kanban_tickets(external_provider, external_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_kanban_tickets_external;
      ALTER TABLE kanban_tickets DROP COLUMN external_url;
      ALTER TABLE kanban_tickets DROP COLUMN external_id;
      ALTER TABLE kanban_tickets DROP COLUMN external_provider;
    `
  }
```

This adds three nullable columns and a composite index for fast dedup lookups.

- [ ] **Step 2: Verify the app starts and migration runs**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -5`

The build should succeed. When the app next runs, migration v15 will execute automatically.

- [ ] **Step 3: Commit**

```bash
git add src/main/db/schema.ts
git commit -m "feat(ticket-import): add migration v15 — external_provider, external_id, external_url columns"
```

---

## Task 4: Update Database Types & Service

**Files:**
- Modify: `src/main/db/types.ts`
- Modify: `src/main/db/database.ts`

- [ ] **Step 1: Add external fields to KanbanTicket types**

In `src/main/db/types.ts`, add three fields to `KanbanTicket` (after `archived_at`):

```typescript
  external_provider: string | null
  external_id: string | null
  external_url: string | null
```

Add the same three fields to `KanbanTicketCreate` (all optional):

```typescript
  external_provider?: string | null
  external_id?: string | null
  external_url?: string | null
```

Do NOT add them to `KanbanTicketUpdate` — external source should be immutable after import.

- [ ] **Step 2: Update mapKanbanTicketRow in database.ts**

In `src/main/db/database.ts`, find the `mapKanbanTicketRow` method (near line 106-134). Add these three lines to the returned object, after `archived_at`:

```typescript
    external_provider: (row.external_provider as string) ?? null,
    external_id: (row.external_id as string) ?? null,
    external_url: (row.external_url as string) ?? null
```

- [ ] **Step 3: Update createKanbanTicket in database.ts**

In `src/main/db/database.ts`, find the `createKanbanTicket` method (near line 1614). Add variable extraction after the existing variable assignments (after `planReady`):

```typescript
    const externalProvider = data.external_provider ?? null
    const externalId = data.external_id ?? null
    const externalUrl = data.external_url ?? null
```

Update the SQL INSERT to include the three new columns. Change the `prepare` call to:

```typescript
    db.prepare(
      `INSERT INTO kanban_tickets (id, project_id, title, description, attachments, "column", sort_order, current_session_id, worktree_id, mode, plan_ready, external_provider, external_id, external_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.project_id,
      data.title,
      description,
      attachmentsJson,
      column,
      sortOrder,
      currentSessionId,
      worktreeId,
      mode,
      planReady,
      externalProvider,
      externalId,
      externalUrl,
      now,
      now
    )
```

- [ ] **Step 4: Add getKanbanTicketByExternalId method to database.ts**

Add this method after the existing `getKanbanTicket` method (near line 1670):

```typescript
  getKanbanTicketByExternalId(
    externalProvider: string,
    externalId: string,
    projectId: string
  ): KanbanTicket | null {
    const db = this.getDb()
    const row = db
      .prepare(
        'SELECT * FROM kanban_tickets WHERE external_provider = ? AND external_id = ? AND project_id = ?'
      )
      .get(externalProvider, externalId, projectId) as Record<string, unknown> | undefined
    return row ? this.mapKanbanTicketRow(row) : null
  }
```

- [ ] **Step 5: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -5`

- [ ] **Step 6: Commit**

```bash
git add src/main/db/types.ts src/main/db/database.ts
git commit -m "feat(ticket-import): add external source fields to KanbanTicket type and DB methods"
```

---

## Task 5: GitHub Provider Implementation

**Files:**
- Create: `src/main/services/ticket-providers/github-provider.ts`

- [ ] **Step 1: Create the GitHub provider**

```typescript
// src/main/services/ticket-providers/github-provider.ts

import { exec } from 'child_process'
import { promisify } from 'util'
import type {
  TicketProvider,
  SettingsField,
  RemoteIssue,
  RemoteIssueListResult,
  RemoteStatus
} from './ticket-provider-types'
import { createLogger } from '../logger'

const execAsync = promisify(exec)
const log = createLogger({ component: 'GitHubProvider' })

export class GitHubProvider implements TicketProvider {
  readonly id = 'github' as const
  readonly name = 'GitHub Issues'
  readonly icon = 'github'

  getSettingsSchema(): SettingsField[] {
    return [
      {
        key: 'github_pat',
        label: 'Personal Access Token',
        type: 'password',
        required: false,
        placeholder: 'ghp_... (optional if gh CLI is authenticated)'
      }
    ]
  }

  async authenticate(settings: Record<string, string>): Promise<string | null> {
    const token = await this.resolveToken(settings)
    if (!token) {
      return 'No GitHub token found. Install and authenticate the GitHub CLI (`gh auth login`), or provide a Personal Access Token in Settings > Integrations.'
    }

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) {
        return `GitHub authentication failed (HTTP ${res.status}). Check your token.`
      }
      return null
    } catch (err) {
      return `GitHub authentication failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async detectRepo(projectPath: string): Promise<string | null> {
    try {
      // Try `gh` CLI first — it handles all URL formats
      const { stdout } = await execAsync(
        "gh repo view --json nameWithOwner -q '.nameWithOwner'",
        { cwd: projectPath, timeout: 5000 }
      )
      const trimmed = stdout.trim()
      if (trimmed && trimmed.includes('/')) return trimmed
    } catch {
      // gh CLI not available or not a GitHub repo — try git remote parsing
    }

    try {
      const { stdout } = await execAsync('git remote get-url origin', {
        cwd: projectPath,
        timeout: 5000
      })
      return this.parseGitHubUrl(stdout.trim())
    } catch {
      return null
    }
  }

  async listIssues(
    repo: string,
    options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
    settings: Record<string, string>
  ): Promise<RemoteIssueListResult> {
    const token = await this.resolveToken(settings)
    if (!token) {
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const { page, perPage, state, search } = options

    // If searching, use the search API
    if (search && search.trim()) {
      return this.searchIssues(repo, token, { page, perPage, state, query: search.trim() })
    }

    // Otherwise use the standard issues endpoint
    const url = new URL(`https://api.github.com/repos/${repo}/issues`)
    url.searchParams.set('state', state)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))
    url.searchParams.set('sort', 'updated')
    url.searchParams.set('direction', 'desc')

    const res = await this.ghFetch(url.toString(), token)
    if (!res.ok) {
      log.error('Failed to list issues', { status: res.status, repo })
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const data = (await res.json()) as Array<Record<string, unknown>>
    // GitHub issues endpoint also returns PRs — filter them out
    const issuesOnly = data.filter((item) => !item.pull_request)

    const linkHeader = res.headers.get('link') ?? ''
    const hasNextPage = linkHeader.includes('rel="next"')

    return {
      issues: issuesOnly.map((item) => this.mapIssue(item)),
      hasNextPage,
      totalCount: -1 // Not available from list endpoint
    }
  }

  async getAvailableStatuses(
    _repo: string,
    _externalId: string,
    _settings: Record<string, string>
  ): Promise<RemoteStatus[]> {
    // GitHub Issues only support open/closed
    return [
      { id: 'open', label: 'Open' },
      { id: 'closed', label: 'Closed' }
    ]
  }

  async updateRemoteStatus(
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    const token = await this.resolveToken(settings)
    if (!token) {
      return { success: false, error: 'No GitHub token available.' }
    }

    if (statusId !== 'open' && statusId !== 'closed') {
      return { success: false, error: `Invalid status: "${statusId}". Must be "open" or "closed".` }
    }

    try {
      const res = await this.ghFetch(
        `https://api.github.com/repos/${repo}/issues/${externalId}`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({ state: statusId })
        }
      )

      if (!res.ok) {
        const body = await res.text()
        return { success: false, error: `GitHub API error (${res.status}): ${body}` }
      }
      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: `Failed to update status: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async resolveToken(settings: Record<string, string>): Promise<string | null> {
    // 1. User-provided PAT from settings
    if (settings.github_pat?.trim()) {
      return settings.github_pat.trim()
    }

    // 2. Try `gh auth token`
    try {
      const { stdout } = await execAsync('gh auth token', { timeout: 5000 })
      const token = stdout.trim()
      if (token) return token
    } catch {
      // gh CLI not available or not authenticated
    }

    // 3. GITHUB_TOKEN env var
    if (process.env.GITHUB_TOKEN?.trim()) {
      return process.env.GITHUB_TOKEN.trim()
    }

    return null
  }

  private async ghFetch(
    url: string,
    token: string,
    init?: RequestInit
  ): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers
      }
    })
  }

  private async searchIssues(
    repo: string,
    token: string,
    options: { page: number; perPage: number; state: string; query: string }
  ): Promise<RemoteIssueListResult> {
    const stateFilter = options.state === 'all' ? '' : ` state:${options.state}`
    const q = `${options.query} repo:${repo} is:issue${stateFilter}`

    const url = new URL('https://api.github.com/search/issues')
    url.searchParams.set('q', q)
    url.searchParams.set('page', String(options.page))
    url.searchParams.set('per_page', String(options.perPage))
    url.searchParams.set('sort', 'updated')
    url.searchParams.set('order', 'desc')

    const res = await this.ghFetch(url.toString(), token)
    if (!res.ok) {
      log.error('Failed to search issues', { status: res.status, repo })
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const data = (await res.json()) as { total_count: number; items: Array<Record<string, unknown>> }
    const linkHeader = res.headers.get('link') ?? ''
    const hasNextPage = linkHeader.includes('rel="next"')

    return {
      issues: data.items.map((item) => this.mapIssue(item)),
      hasNextPage,
      totalCount: data.total_count
    }
  }

  private mapIssue(item: Record<string, unknown>): RemoteIssue {
    return {
      externalId: String(item.number),
      title: item.title as string,
      body: (item.body as string) ?? null,
      state: (item.state as string) === 'open' ? 'open' : 'closed',
      url: item.html_url as string,
      createdAt: item.created_at as string,
      updatedAt: item.updated_at as string
    }
  }

  private parseGitHubUrl(url: string): string | null {
    // Handles: https://github.com/owner/repo.git, git@github.com:owner/repo.git, etc.
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`

    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/)
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`

    return null
  }
}
```

- [ ] **Step 2: Register in barrel export**

In `src/main/services/ticket-providers/index.ts`, add:

```typescript
export { GitHubProvider } from './github-provider'
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add src/main/services/ticket-providers/github-provider.ts src/main/services/ticket-providers/index.ts
git commit -m "feat(ticket-import): implement GitHubProvider with auth, list, import, and status update"
```

---

## Task 6: IPC Handlers

**Files:**
- Create: `src/main/ipc/ticket-import-handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Create IPC handler file**

```typescript
// src/main/ipc/ticket-import-handlers.ts

import { ipcMain } from 'electron'
import { getTicketProviderManager } from '../services/ticket-providers'
import { getDatabase } from '../db'
import type { TicketProviderId } from '../services/ticket-providers'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'ticket-import-handlers' })

export function registerTicketImportHandlers(): void {
  log.info('Registering ticket import handlers')

  // List registered providers (id, name, icon)
  ipcMain.handle('ticketImport:listProviders', () => {
    const manager = getTicketProviderManager()
    return manager.listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon
    }))
  })

  // Get settings schema for a provider
  ipcMain.handle('ticketImport:getSettingsSchema', (_event, providerId: TicketProviderId) => {
    const provider = getTicketProviderManager().getProvider(providerId)
    return provider.getSettingsSchema()
  })

  // Test authentication
  ipcMain.handle(
    'ticketImport:authenticate',
    async (_event, providerId: TicketProviderId, settings: Record<string, string>) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      const error = await provider.authenticate(settings)
      return { success: error === null, error }
    }
  )

  // Detect repo from project path
  ipcMain.handle(
    'ticketImport:detectRepo',
    async (_event, providerId: TicketProviderId, projectPath: string) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      const repo = await provider.detectRepo(projectPath)
      return { repo }
    }
  )

  // List remote issues (paginated)
  ipcMain.handle(
    'ticketImport:listIssues',
    async (
      _event,
      providerId: TicketProviderId,
      repo: string,
      options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
      settings: Record<string, string>
    ) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      return provider.listIssues(repo, options, settings)
    }
  )

  // Import selected issues into kanban
  ipcMain.handle(
    'ticketImport:importIssues',
    async (
      _event,
      providerId: TicketProviderId,
      projectId: string,
      repo: string,
      issues: Array<{ externalId: string; title: string; body: string | null; state: string; url: string }>
    ) => {
      const db = getDatabase()
      const imported: string[] = []
      const skipped: string[] = []

      for (const issue of issues) {
        // Dedup check
        const existing = db.getKanbanTicketByExternalId(providerId, issue.externalId, projectId)
        if (existing) {
          skipped.push(issue.externalId)
          continue
        }

        const column = issue.state === 'closed' ? 'done' : 'todo'
        db.createKanbanTicket({
          project_id: projectId,
          title: issue.title,
          description: issue.body,
          column,
          external_provider: providerId,
          external_id: issue.externalId,
          external_url: issue.url
        })
        imported.push(issue.externalId)
      }

      return { imported, skipped }
    }
  )

  // Get available statuses for a remote issue
  ipcMain.handle(
    'ticketImport:getAvailableStatuses',
    async (
      _event,
      providerId: TicketProviderId,
      repo: string,
      externalId: string,
      settings: Record<string, string>
    ) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      return provider.getAvailableStatuses(repo, externalId, settings)
    }
  )

  // Update status on the remote platform
  ipcMain.handle(
    'ticketImport:updateRemoteStatus',
    async (
      _event,
      providerId: TicketProviderId,
      repo: string,
      externalId: string,
      statusId: string,
      settings: Record<string, string>
    ) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      return provider.updateRemoteStatus(repo, externalId, statusId, settings)
    }
  )
}
```

- [ ] **Step 2: Register handlers and initialize manager in main/index.ts**

In `src/main/index.ts`, add the imports near the top with the other handler imports:

```typescript
import { registerTicketImportHandlers } from './ipc/ticket-import-handlers'
import { initTicketProviderManager } from './services/ticket-providers'
import { GitHubProvider } from './services/ticket-providers'
```

Find the IPC registration block (near line 530-539 where `registerKanbanHandlers()` is called). Add these two lines after `registerKanbanHandlers()`:

```typescript
  initTicketProviderManager([new GitHubProvider()])
  registerTicketImportHandlers()
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/ticket-import-handlers.ts src/main/index.ts
git commit -m "feat(ticket-import): add IPC handlers and initialize provider manager on startup"
```

---

## Task 7: Preload Bridge & Window Types

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

- [ ] **Step 1: Add ticketImport bridge in preload/index.ts**

In `src/preload/index.ts`, find the `kanban` object definition (near line 1747). Add the following **before** the `if (process.contextIsolated)` block (near line 1807):

```typescript
const ticketImport = {
  listProviders: (): Promise<Array<{ id: string; name: string; icon: string }>> =>
    ipcRenderer.invoke('ticketImport:listProviders'),
  getSettingsSchema: (
    providerId: string
  ): Promise<Array<{ key: string; label: string; type: string; required: boolean; placeholder?: string }>> =>
    ipcRenderer.invoke('ticketImport:getSettingsSchema', providerId),
  authenticate: (
    providerId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error: string | null }> =>
    ipcRenderer.invoke('ticketImport:authenticate', providerId, settings),
  detectRepo: (
    providerId: string,
    projectPath: string
  ): Promise<{ repo: string | null }> =>
    ipcRenderer.invoke('ticketImport:detectRepo', providerId, projectPath),
  listIssues: (
    providerId: string,
    repo: string,
    options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
    settings: Record<string, string>
  ): Promise<{
    issues: Array<{
      externalId: string
      title: string
      body: string | null
      state: 'open' | 'closed'
      url: string
      createdAt: string
      updatedAt: string
    }>
    hasNextPage: boolean
    totalCount: number
  }> => ipcRenderer.invoke('ticketImport:listIssues', providerId, repo, options, settings),
  importIssues: (
    providerId: string,
    projectId: string,
    repo: string,
    issues: Array<{ externalId: string; title: string; body: string | null; state: string; url: string }>
  ): Promise<{ imported: string[]; skipped: string[] }> =>
    ipcRenderer.invoke('ticketImport:importIssues', providerId, projectId, repo, issues),
  getAvailableStatuses: (
    providerId: string,
    repo: string,
    externalId: string,
    settings: Record<string, string>
  ): Promise<Array<{ id: string; label: string }>> =>
    ipcRenderer.invoke('ticketImport:getAvailableStatuses', providerId, repo, externalId, settings),
  updateRemoteStatus: (
    providerId: string,
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ticketImport:updateRemoteStatus', providerId, repo, externalId, statusId, settings)
}
```

Then add to the `contextBridge.exposeInMainWorld` block (after the `kanban` line):

```typescript
    contextBridge.exposeInMainWorld('ticketImport', ticketImport)
```

And in the `else` fallback block, add:

```typescript
  // @ts-expect-error (define in dts)
  window.ticketImport = ticketImport
```

- [ ] **Step 2: Add ticketImport to Window interface in preload/index.d.ts**

In `src/preload/index.d.ts`, find the `kanban: {` block (near line 1309-1334). After its closing `}`, add:

```typescript
    ticketImport: {
      listProviders: () => Promise<Array<{ id: string; name: string; icon: string }>>
      getSettingsSchema: (
        providerId: string
      ) => Promise<Array<{ key: string; label: string; type: string; required: boolean; placeholder?: string }>>
      authenticate: (
        providerId: string,
        settings: Record<string, string>
      ) => Promise<{ success: boolean; error: string | null }>
      detectRepo: (
        providerId: string,
        projectPath: string
      ) => Promise<{ repo: string | null }>
      listIssues: (
        providerId: string,
        repo: string,
        options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
        settings: Record<string, string>
      ) => Promise<{
        issues: Array<{
          externalId: string
          title: string
          body: string | null
          state: 'open' | 'closed'
          url: string
          createdAt: string
          updatedAt: string
        }>
        hasNextPage: boolean
        totalCount: number
      }>
      importIssues: (
        providerId: string,
        projectId: string,
        repo: string,
        issues: Array<{ externalId: string; title: string; body: string | null; state: string; url: string }>
      ) => Promise<{ imported: string[]; skipped: string[] }>
      getAvailableStatuses: (
        providerId: string,
        repo: string,
        externalId: string,
        settings: Record<string, string>
      ) => Promise<Array<{ id: string; label: string }>>
      updateRemoteStatus: (
        providerId: string,
        repo: string,
        externalId: string,
        statusId: string,
        settings: Record<string, string>
      ) => Promise<{ success: boolean; error?: string }>
    }
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(ticket-import): add ticketImport preload bridge and Window type declarations"
```

---

## Task 8: GraphQL Schema & Resolvers

**Files:**
- Create: `src/server/schema/types/ticket-import.graphql`
- Modify: `src/server/schema/schema.graphql`
- Create: `src/server/resolvers/query/ticket-import.resolvers.ts`
- Create: `src/server/resolvers/mutation/ticket-import.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

- [ ] **Step 1: Create GraphQL type definitions**

```graphql
# src/server/schema/types/ticket-import.graphql

type TicketProviderInfo {
  id: String!
  name: String!
  icon: String!
}

type SettingsFieldInfo {
  key: String!
  label: String!
  type: String!
  required: Boolean!
  placeholder: String
}

type RemoteIssue {
  externalId: String!
  title: String!
  body: String
  state: String!
  url: String!
  createdAt: String!
  updatedAt: String!
}

type RemoteIssueListResult {
  issues: [RemoteIssue!]!
  hasNextPage: Boolean!
  totalCount: Int!
}

type RemoteStatus {
  id: String!
  label: String!
}

type AuthResult {
  success: Boolean!
  error: String
}

type DetectRepoResult {
  repo: String
}

type ImportResult {
  imported: [String!]!
  skipped: [String!]!
}

input ListIssuesInput {
  providerId: String!
  repo: String!
  page: Int!
  perPage: Int!
  state: String!
  search: String
}

input ImportIssueInput {
  externalId: String!
  title: String!
  body: String
  state: String!
  url: String!
}

input ImportIssuesInput {
  providerId: String!
  projectId: String!
  repo: String!
  issues: [ImportIssueInput!]!
}

input UpdateRemoteStatusInput {
  providerId: String!
  repo: String!
  externalId: String!
  statusId: String!
}
```

- [ ] **Step 2: Add queries and mutations to schema.graphql**

In `src/server/schema/schema.graphql`, add to the `type Query` block:

```graphql
  # --- Ticket Import ---
  ticketImportProviders: [TicketProviderInfo!]!
  ticketImportSettingsSchema(providerId: String!): [SettingsFieldInfo!]!
  ticketImportDetectRepo(providerId: String!, projectPath: String!): DetectRepoResult!
  ticketImportListIssues(input: ListIssuesInput!, settings: String!): RemoteIssueListResult!
  ticketImportAvailableStatuses(providerId: String!, repo: String!, externalId: String!, settings: String!): [RemoteStatus!]!
```

Add to the `type Mutation` block:

```graphql
  # --- Ticket Import ---
  ticketImportAuthenticate(providerId: String!, settings: String!): AuthResult!
  ticketImportIssues(input: ImportIssuesInput!): ImportResult!
  ticketImportUpdateRemoteStatus(input: UpdateRemoteStatusInput!, settings: String!): SuccessResult!
```

Note: `settings` is passed as a JSON string for simplicity (parsed in resolvers).

- [ ] **Step 3: Create query resolvers**

```typescript
// src/server/resolvers/query/ticket-import.resolvers.ts

import type { Resolvers } from '../../__generated__/resolvers-types'
import { getTicketProviderManager } from '../.././../main/services/ticket-providers'
import type { TicketProviderId } from '../.././../main/services/ticket-providers'

export const ticketImportQueryResolvers: Resolvers = {
  Query: {
    ticketImportProviders: () => {
      return getTicketProviderManager()
        .listProviders()
        .map((p) => ({ id: p.id, name: p.name, icon: p.icon }))
    },

    ticketImportSettingsSchema: (_parent, { providerId }) => {
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      return provider.getSettingsSchema()
    },

    ticketImportDetectRepo: async (_parent, { providerId, projectPath }) => {
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      const repo = await provider.detectRepo(projectPath)
      return { repo }
    },

    ticketImportListIssues: async (_parent, { input, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(input.providerId as TicketProviderId)
      return provider.listIssues(
        input.repo,
        {
          page: input.page,
          perPage: input.perPage,
          state: input.state as 'open' | 'closed' | 'all',
          search: input.search ?? undefined
        },
        settings
      )
    },

    ticketImportAvailableStatuses: async (_parent, { providerId, repo, externalId, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      return provider.getAvailableStatuses(repo, externalId, settings)
    }
  }
}
```

- [ ] **Step 4: Create mutation resolvers**

```typescript
// src/server/resolvers/mutation/ticket-import.resolvers.ts

import type { Resolvers } from '../../__generated__/resolvers-types'
import { getTicketProviderManager } from '../.././../main/services/ticket-providers'
import type { TicketProviderId } from '../.././../main/services/ticket-providers'

export const ticketImportMutationResolvers: Resolvers = {
  Mutation: {
    ticketImportAuthenticate: async (_parent, { providerId, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      const error = await provider.authenticate(settings)
      return { success: error === null, error }
    },

    ticketImportIssues: async (_parent, { input }, ctx) => {
      const db = ctx.db
      const imported: string[] = []
      const skipped: string[] = []

      for (const issue of input.issues) {
        const existing = db.getKanbanTicketByExternalId(
          input.providerId,
          issue.externalId,
          input.projectId
        )
        if (existing) {
          skipped.push(issue.externalId)
          continue
        }

        const column = issue.state === 'closed' ? 'done' : 'todo'
        db.createKanbanTicket({
          project_id: input.projectId,
          title: issue.title,
          description: issue.body ?? null,
          column,
          external_provider: input.providerId,
          external_id: issue.externalId,
          external_url: issue.url
        })
        imported.push(issue.externalId)
      }

      return { imported, skipped }
    },

    ticketImportUpdateRemoteStatus: async (_parent, { input, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(input.providerId as TicketProviderId)
      const result = await provider.updateRemoteStatus(
        input.repo,
        input.externalId,
        input.statusId,
        settings
      )
      return { success: result.success }
    }
  }
}
```

- [ ] **Step 5: Register resolvers in index.ts**

In `src/server/resolvers/index.ts`, add imports:

```typescript
import { ticketImportQueryResolvers } from './query/ticket-import.resolvers'
import { ticketImportMutationResolvers } from './mutation/ticket-import.resolvers'
```

Add both to the `deepMerge` call in `mergeResolvers()`, after `kanbanMutationResolvers`:

```typescript
    ticketImportQueryResolvers,
    ticketImportMutationResolvers,
```

- [ ] **Step 6: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

Note: If the project uses graphql-codegen, run that first to regenerate types:
Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npx graphql-codegen 2>&1 | tail -5`

- [ ] **Step 7: Commit**

```bash
git add src/server/schema/types/ticket-import.graphql src/server/schema/schema.graphql src/server/resolvers/query/ticket-import.resolvers.ts src/server/resolvers/mutation/ticket-import.resolvers.ts src/server/resolvers/index.ts
git commit -m "feat(ticket-import): add GraphQL schema, queries, and mutations for ticket import"
```

---

## Task 9: GraphQL Transport Adapter

**Files:**
- Create: `src/renderer/src/transport/graphql/adapters/ticket-import.ts`
- Modify: `src/renderer/src/transport/types.ts`

- [ ] **Step 1: Create the transport adapter**

This adapter lets the renderer call ticket-import operations via GraphQL in headless/web mode (mirroring the pattern in `src/renderer/src/transport/graphql/adapters/kanban.ts`):

```typescript
// src/renderer/src/transport/graphql/adapters/ticket-import.ts

import { graphqlQuery } from '../client'

export function createTicketImportAdapter() {
  return {
    async listProviders() {
      const { data } = await graphqlQuery<{
        ticketImportProviders: Array<{ id: string; name: string; icon: string }>
      }>(`query { ticketImportProviders { id name icon } }`)
      return data.ticketImportProviders
    },

    async getSettingsSchema(providerId: string) {
      const { data } = await graphqlQuery<{
        ticketImportSettingsSchema: Array<{
          key: string; label: string; type: string; required: boolean; placeholder: string | null
        }>
      }>(`query ($providerId: String!) {
        ticketImportSettingsSchema(providerId: $providerId) { key label type required placeholder }
      }`, { providerId })
      return data.ticketImportSettingsSchema
    },

    async authenticate(providerId: string, settings: Record<string, string>) {
      const { data } = await graphqlQuery<{
        ticketImportAuthenticate: { success: boolean; error: string | null }
      }>(`mutation ($providerId: String!, $settings: String!) {
        ticketImportAuthenticate(providerId: $providerId, settings: $settings) { success error }
      }`, { providerId, settings: JSON.stringify(settings) })
      return data.ticketImportAuthenticate
    },

    async detectRepo(providerId: string, projectPath: string) {
      const { data } = await graphqlQuery<{
        ticketImportDetectRepo: { repo: string | null }
      }>(`query ($providerId: String!, $projectPath: String!) {
        ticketImportDetectRepo(providerId: $providerId, projectPath: $projectPath) { repo }
      }`, { providerId, projectPath })
      return data.ticketImportDetectRepo
    },

    async listIssues(
      providerId: string,
      repo: string,
      options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
      settings: Record<string, string>
    ) {
      const { data } = await graphqlQuery<{
        ticketImportListIssues: {
          issues: Array<{
            externalId: string; title: string; body: string | null
            state: 'open' | 'closed'; url: string; createdAt: string; updatedAt: string
          }>
          hasNextPage: boolean
          totalCount: number
        }
      }>(`query ($input: ListIssuesInput!, $settings: String!) {
        ticketImportListIssues(input: $input, settings: $settings) {
          issues { externalId title body state url createdAt updatedAt }
          hasNextPage totalCount
        }
      }`, {
        input: { providerId, repo, ...options },
        settings: JSON.stringify(settings)
      })
      return data.ticketImportListIssues
    },

    async importIssues(
      providerId: string,
      projectId: string,
      repo: string,
      issues: Array<{ externalId: string; title: string; body: string | null; state: string; url: string }>
    ) {
      const { data } = await graphqlQuery<{
        ticketImportIssues: { imported: string[]; skipped: string[] }
      }>(`mutation ($input: ImportIssuesInput!) {
        ticketImportIssues(input: $input) { imported skipped }
      }`, { input: { providerId, projectId, repo, issues } })
      return data.ticketImportIssues
    },

    async getAvailableStatuses(
      providerId: string,
      repo: string,
      externalId: string,
      settings: Record<string, string>
    ) {
      const { data } = await graphqlQuery<{
        ticketImportAvailableStatuses: Array<{ id: string; label: string }>
      }>(`query ($providerId: String!, $repo: String!, $externalId: String!, $settings: String!) {
        ticketImportAvailableStatuses(
          providerId: $providerId, repo: $repo, externalId: $externalId, settings: $settings
        ) { id label }
      }`, { providerId, repo, externalId, settings: JSON.stringify(settings) })
      return data.ticketImportAvailableStatuses
    },

    async updateRemoteStatus(
      providerId: string,
      repo: string,
      externalId: string,
      statusId: string,
      settings: Record<string, string>
    ) {
      const { data } = await graphqlQuery<{
        ticketImportUpdateRemoteStatus: { success: boolean }
      }>(`mutation ($input: UpdateRemoteStatusInput!, $settings: String!) {
        ticketImportUpdateRemoteStatus(input: $input, settings: $settings) { success }
      }`, {
        input: { providerId, repo, externalId, statusId },
        settings: JSON.stringify(settings)
      })
      return data.ticketImportUpdateRemoteStatus
    }
  }
}
```

- [ ] **Step 2: Export the type alias**

In `src/renderer/src/transport/types.ts`, add at the end:

```typescript
export type TicketImportApi = Window['ticketImport']
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/transport/graphql/adapters/ticket-import.ts src/renderer/src/transport/types.ts
git commit -m "feat(ticket-import): add GraphQL transport adapter for headless/web mode"
```

---

## Task 10: Import Tickets Modal

**Files:**
- Create: `src/renderer/src/components/kanban/ImportTicketsModal.tsx`

- [ ] **Step 1: Create the import modal component**

```tsx
// src/renderer/src/components/kanban/ImportTicketsModal.tsx

import { useState, useEffect, useCallback } from 'react'
import { Download, Search, ExternalLink, Loader2, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from 'sonner'

interface RemoteIssue {
  externalId: string
  title: string
  body: string | null
  state: 'open' | 'closed'
  url: string
  createdAt: string
  updatedAt: string
}

interface ImportTicketsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectPath: string
}

const PER_PAGE = 30

export function ImportTicketsModal({
  open,
  onOpenChange,
  projectId,
  projectPath
}: ImportTicketsModalProps) {
  const loadTickets = useKanbanStore((s) => s.loadTickets)

  // State
  const [repo, setRepo] = useState<string | null>(null)
  const [manualRepo, setManualRepo] = useState('')
  const [detectingRepo, setDetectingRepo] = useState(false)
  const [detectionFailed, setDetectionFailed] = useState(false)

  const [issues, setIssues] = useState<RemoteIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [search, setSearch] = useState('')
  const [showClosed, setShowClosed] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)

  const effectiveRepo = repo ?? (manualRepo.includes('/') ? manualRepo.trim() : null)

  // Load provider settings from the app settings store
  const getProviderSettings = useCallback((): Record<string, string> => {
    const allSettings = useSettingsStore.getState()
    const pat = (allSettings as Record<string, unknown>).github_pat as string | undefined
    return pat ? { github_pat: pat } : {}
  }, [])

  // Auto-detect repo on open
  useEffect(() => {
    if (!open) return
    setDetectingRepo(true)
    setDetectionFailed(false)
    setRepo(null)
    setManualRepo('')
    setIssues([])
    setSelected(new Set())
    setPage(1)
    setSearch('')
    setShowClosed(false)
    setImportProgress(null)

    window.ticketImport
      .detectRepo('github', projectPath)
      .then(({ repo: detected }) => {
        if (detected) {
          setRepo(detected)
        } else {
          setDetectionFailed(true)
        }
      })
      .catch(() => setDetectionFailed(true))
      .finally(() => setDetectingRepo(false))
  }, [open, projectPath])

  // Fetch issues when repo/page/search/showClosed changes
  useEffect(() => {
    if (!open || !effectiveRepo) return
    setLoading(true)
    const state = showClosed ? 'all' : 'open'

    window.ticketImport
      .listIssues('github', effectiveRepo, { page, perPage: PER_PAGE, state, search: search || undefined }, getProviderSettings())
      .then((result) => {
        setIssues(result.issues)
        setHasNextPage(result.hasNextPage)
      })
      .catch((err) => {
        console.error('Failed to fetch issues:', err)
        toast.error('Failed to fetch issues. Check your GitHub authentication.')
        setIssues([])
      })
      .finally(() => setLoading(false))
  }, [open, effectiveRepo, page, search, showClosed, getProviderSettings])

  // Toggle selection
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === issues.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(issues.map((i) => i.externalId)))
    }
  }

  // Import
  const handleImport = async () => {
    if (!effectiveRepo || selected.size === 0) return
    setImporting(true)

    const toImport = issues.filter((i) => selected.has(i.externalId))
    setImportProgress({ current: 0, total: toImport.length })

    try {
      const result = await window.ticketImport.importIssues(
        'github',
        projectId,
        effectiveRepo,
        toImport.map((i) => ({
          externalId: i.externalId,
          title: i.title,
          body: i.body,
          state: i.state,
          url: i.url
        }))
      )

      setImportProgress({ current: toImport.length, total: toImport.length })

      const msgs: string[] = []
      if (result.imported.length > 0) msgs.push(`Imported ${result.imported.length} issue${result.imported.length > 1 ? 's' : ''}`)
      if (result.skipped.length > 0) msgs.push(`Skipped ${result.skipped.length} duplicate${result.skipped.length > 1 ? 's' : ''}`)
      toast.success(msgs.join('. '))

      // Refresh kanban board
      await loadTickets(projectId)
      onOpenChange(false)
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  // Search with debounce
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            Import from GitHub
            {effectiveRepo && (
              <span className="text-xs font-normal text-muted-foreground ml-1">
                {effectiveRepo}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col">
          {/* Repo detection / manual entry */}
          {detectingRepo && (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Detecting GitHub repository...
            </div>
          )}

          {detectionFailed && !repo && (
            <div className="px-4 pt-3">
              <div className="flex items-center gap-2 text-sm text-amber-500 mb-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                No GitHub remote detected.
              </div>
              <Input
                placeholder="Enter repository (owner/repo)"
                value={manualRepo}
                onChange={(e) => setManualRepo(e.target.value)}
                className="text-sm"
              />
            </div>
          )}

          {/* Search + filters */}
          {effectiveRepo && !detectingRepo && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search issues..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="pl-8 h-8 text-sm"
                  />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={showClosed}
                    onCheckedChange={(checked) => {
                      setShowClosed(checked === true)
                      setPage(1)
                    }}
                  />
                  Show closed
                </label>
              </div>

              {/* Issues list */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading issues...
                  </div>
                ) : issues.length === 0 ? (
                  <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                    No issues found.
                  </div>
                ) : (
                  <div className="divide-y">
                    {/* Select all header */}
                    <div className="flex items-center gap-3 px-4 py-2 bg-muted/30 sticky top-0 z-10">
                      <Checkbox
                        checked={selected.size === issues.length && issues.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                      <span className="text-xs text-muted-foreground">
                        {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
                      </span>
                    </div>

                    {issues.map((issue) => (
                      <div
                        key={issue.externalId}
                        className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/20 cursor-pointer transition-colors"
                        onClick={() => toggleSelect(issue.externalId)}
                      >
                        <Checkbox
                          checked={selected.has(issue.externalId)}
                          onCheckedChange={() => toggleSelect(issue.externalId)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground font-mono">
                              #{issue.externalId}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                issue.state === 'open'
                                  ? 'bg-green-500/10 text-green-500'
                                  : 'bg-purple-500/10 text-purple-500'
                              }`}
                            >
                              {issue.state}
                            </span>
                          </div>
                          <p className="text-sm font-medium truncate mt-0.5">
                            {issue.title}
                          </p>
                        </div>
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pagination */}
              {(page > 1 || hasNextPage) && (
                <div className="flex items-center justify-between px-4 py-2 border-t shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!hasNextPage || loading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: import button + progress */}
        <DialogFooter className="px-4 py-3 border-t shrink-0">
          {importProgress && (
            <div className="flex-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Importing {importProgress.current}/{importProgress.total}...
            </div>
          )}
          <Button
            onClick={handleImport}
            disabled={selected.size === 0 || importing || !effectiveRepo}
            size="sm"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Import {selected.size > 0 ? `(${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/kanban/ImportTicketsModal.tsx
git commit -m "feat(ticket-import): add ImportTicketsModal with browse, search, select, and batch import"
```

---

## Task 11: KanbanBoard — Add Import Button

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx`

- [ ] **Step 1: Add the import button to the board header**

Replace the entire `KanbanBoard.tsx` file content. The key change is wrapping the columns in a new layout that has a header bar with an Import button:

In `src/renderer/src/components/kanban/KanbanBoard.tsx`, replace the return statement (the JSX from `<LayoutGroup>` onwards). Add state and the import for the modal at the top, and add a board header:

Add imports at the top:

```typescript
import { useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImportTicketsModal } from '@/components/kanban/ImportTicketsModal'
```

Replace `useEffect` import with:
```typescript
import { useEffect, useState } from 'react'
```
(Remove the duplicate `useState` import if you added it both places — just ensure `useState` is imported once from 'react'.)

Then add a `projectPath` prop. Look at how `KanbanBoard` is rendered — the parent passes `projectId`. We also need `projectPath` for repo detection. Update the props interface:

```typescript
interface KanbanBoardProps {
  projectId: string
  projectPath: string
}
```

Update the function signature:

```typescript
export function KanbanBoard({ projectId, projectPath }: KanbanBoardProps)
```

Inside the component, add state for the modal:

```typescript
  const [showImport, setShowImport] = useState(false)
```

Replace the return JSX with:

```tsx
  return (
    <LayoutGroup>
      <div className="flex flex-1 flex-col min-h-0">
        {/* Board header */}
        <div className="flex items-center justify-end px-4 pt-3 pb-0 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowImport(true)}
            className="gap-1.5 text-xs text-muted-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            Import
          </Button>
        </div>

        {/* Columns */}
        <motion.div
          layoutScroll
          data-testid="kanban-board"
          className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4"
        >
          {COLUMNS.map((column) => (
            <KanbanColumn
              key={column}
              column={column}
              tickets={getTicketsByColumn(projectId, column)}
              archivedTickets={column === 'done' ? getArchivedTicketsByColumn(projectId, 'done') : undefined}
              projectId={projectId}
            />
          ))}
          <KanbanTicketModal />
        </motion.div>
      </div>

      <ImportTicketsModal
        open={showImport}
        onOpenChange={setShowImport}
        projectId={projectId}
        projectPath={projectPath}
      />
    </LayoutGroup>
  )
```

- [ ] **Step 2: Pass projectPath from the parent**

Find where `<KanbanBoard>` is rendered in `src/renderer/src/components/layout/MainPane.tsx` (near line 177-181). It currently passes just `projectId`. You need to also pass `projectPath`. Check how the parent component gets the project data. It likely has access to the selected project's path.

Search for the `KanbanBoard` usage and add `projectPath={selectedProject.path}` or however the project path is available in that scope. The exact code depends on the parent, but the pattern will look like:

```tsx
<KanbanBoard projectId={selectedProjectId} projectPath={selectedProjectPath} />
```

If `selectedProjectPath` isn't readily available, you may need to read it from the project store. Check the project store for a method like `getSelectedProject()` or look at how other components access the project path.

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/kanban/KanbanBoard.tsx src/renderer/src/components/layout/MainPane.tsx
git commit -m "feat(ticket-import): add Import button to kanban board header"
```

---

## Task 12: Provider Badge + Status Update on Ticket Cards

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanTicketCard.tsx`
- Create: `src/renderer/src/components/kanban/UpdateStatusModal.tsx`

- [ ] **Step 1: Create the UpdateStatusModal**

```tsx
// src/renderer/src/components/kanban/UpdateStatusModal.tsx

import { useState, useEffect } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from 'sonner'

interface UpdateStatusModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  externalProvider: string
  externalId: string
  externalUrl: string
  ticketTitle: string
  projectPath: string
}

export function UpdateStatusModal({
  open,
  onOpenChange,
  externalProvider,
  externalId,
  externalUrl,
  ticketTitle,
  projectPath
}: UpdateStatusModalProps) {
  const [statuses, setStatuses] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(false)
  const [updating, setUpdating] = useState(false)

  const getProviderSettings = (): Record<string, string> => {
    const allSettings = useSettingsStore.getState()
    const pat = (allSettings as Record<string, unknown>).github_pat as string | undefined
    return pat ? { github_pat: pat } : {}
  }

  // Detect repo from external URL
  const getRepoFromUrl = (): string | null => {
    const match = externalUrl.match(/github\.com\/([^/]+\/[^/]+)/)
    return match ? match[1] : null
  }

  // Fetch available statuses
  useEffect(() => {
    if (!open) return
    const repo = getRepoFromUrl()
    if (!repo) return

    setLoading(true)
    window.ticketImport
      .getAvailableStatuses(externalProvider, repo, externalId, getProviderSettings())
      .then(setStatuses)
      .catch((err) => {
        toast.error(`Failed to fetch statuses: ${err instanceof Error ? err.message : String(err)}`)
        setStatuses([])
      })
      .finally(() => setLoading(false))
  }, [open, externalProvider, externalId, externalUrl])

  const handleUpdate = async (statusId: string) => {
    const repo = getRepoFromUrl()
    if (!repo) return

    setUpdating(true)
    try {
      const result = await window.ticketImport.updateRemoteStatus(
        externalProvider,
        repo,
        externalId,
        statusId,
        getProviderSettings()
      )
      if (result.success) {
        toast.success(`Updated #${externalId} to "${statuses.find((s) => s.id === statusId)?.label}"`)
        onOpenChange(false)
      } else {
        toast.error(result.error ?? 'Failed to update status')
      }
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <RefreshCw className="h-4 w-4" />
            Update status on GitHub
          </DialogTitle>
          <p className="text-xs text-muted-foreground truncate mt-1">
            #{externalId} — {ticketTitle}
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading statuses...
            </div>
          ) : (
            statuses.map((status) => (
              <Button
                key={status.id}
                variant="outline"
                size="sm"
                disabled={updating}
                onClick={() => handleUpdate(status.id)}
                className="justify-start"
              >
                {status.label}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Add provider badge and context menu item to KanbanTicketCard**

In `src/renderer/src/components/kanban/KanbanTicketCard.tsx`, add these imports at the top:

```typescript
import { Github, RefreshCw } from 'lucide-react'
import { UpdateStatusModal } from './UpdateStatusModal'
```

Inside the component function, add state for the status modal:

```typescript
  const [showStatusUpdate, setShowStatusUpdate] = useState(false)
```

Add a computed property for whether this ticket is externally linked:

```typescript
  const isExternalTicket = !!ticket.external_provider
```

**Add the provider badge to the card display.** Find the ticket title rendering area (the `<p>` or `<span>` that renders `ticket.title`). Add a small GitHub icon badge next to the title. Look for the title element and wrap it or add a sibling:

After the title text, add:

```tsx
{ticket.external_provider === 'github' && (
  <a
    href={ticket.external_url ?? '#'}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => e.stopPropagation()}
    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
    title={`GitHub #${ticket.external_id}`}
  >
    <Github className="h-3 w-3" />
  </a>
)}
```

**Add the context menu item.** Find the `<ContextMenuContent>` block (near line 380). Add this block **before** the `<ContextMenuSeparator />` (near line 461):

```tsx
{/* Update status on remote platform */}
{isExternalTicket && (
  <ContextMenuItem
    data-testid="ctx-update-remote-status"
    onClick={() => setShowStatusUpdate(true)}
    className="gap-2"
  >
    <RefreshCw className="h-3.5 w-3.5" />
    Update on {ticket.external_provider === 'github' ? 'GitHub' : ticket.external_provider}
  </ContextMenuItem>
)}
```

**Add the status modal.** Find the end of the component's return JSX (after the `AlertDialog` for delete confirmation, near line 509+). Add the modal:

```tsx
{isExternalTicket && ticket.external_id && ticket.external_url && (
  <UpdateStatusModal
    open={showStatusUpdate}
    onOpenChange={setShowStatusUpdate}
    externalProvider={ticket.external_provider!}
    externalId={ticket.external_id}
    externalUrl={ticket.external_url}
    ticketTitle={ticket.title}
    projectPath=""
  />
)}
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/kanban/UpdateStatusModal.tsx src/renderer/src/components/kanban/KanbanTicketCard.tsx
git commit -m "feat(ticket-import): add provider badge, status update context menu, and UpdateStatusModal"
```

---

## Task 13: Integrations Settings Section

**Files:**
- Create: `src/renderer/src/components/settings/SettingsIntegrations.tsx`
- Modify: `src/renderer/src/components/settings/SettingsModal.tsx`

- [ ] **Step 1: Create the Integrations settings component**

```tsx
// src/renderer/src/components/settings/SettingsIntegrations.tsx

import { useState, useEffect } from 'react'
import { Loader2, Check, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from 'sonner'

interface ProviderInfo {
  id: string
  name: string
  icon: string
}

interface SettingsFieldDef {
  key: string
  label: string
  type: string
  required: boolean
  placeholder?: string
}

export function SettingsIntegrations() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [schemas, setSchemas] = useState<Record<string, SettingsFieldDef[]>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, boolean | null>>({})

  const { updateSetting } = useSettingsStore()

  // Load providers and their schemas
  useEffect(() => {
    window.ticketImport.listProviders().then(async (provs) => {
      setProviders(provs)
      const schemaMap: Record<string, SettingsFieldDef[]> = {}
      for (const p of provs) {
        schemaMap[p.id] = await window.ticketImport.getSettingsSchema(p.id)
      }
      setSchemas(schemaMap)

      // Load saved values from settings store
      const settings = useSettingsStore.getState() as Record<string, unknown>
      const saved: Record<string, string> = {}
      for (const fields of Object.values(schemaMap)) {
        for (const field of fields) {
          const val = settings[field.key]
          if (typeof val === 'string') saved[field.key] = val
        }
      }
      setValues(saved)
    })
  }, [])

  const handleFieldChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setTestResult((prev) => ({ ...prev }))
    // Persist to settings store
    updateSetting(key as keyof ReturnType<typeof useSettingsStore.getState>, value as never)
  }

  const handleTest = async (providerId: string) => {
    setTesting(providerId)
    setTestResult((prev) => ({ ...prev, [providerId]: null }))

    try {
      const providerSettings: Record<string, string> = {}
      const fields = schemas[providerId] ?? []
      for (const f of fields) {
        if (values[f.key]) providerSettings[f.key] = values[f.key]
      }

      const result = await window.ticketImport.authenticate(providerId, providerSettings)
      setTestResult((prev) => ({ ...prev, [providerId]: result.success }))
      if (result.success) {
        toast.success(`${providers.find((p) => p.id === providerId)?.name}: Connected!`)
      } else {
        toast.error(result.error ?? 'Authentication failed')
      }
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [providerId]: false }))
      toast.error(`Test failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">Integrations</h3>
        <p className="text-xs text-muted-foreground">
          Configure connections to external platforms for ticket import.
        </p>
      </div>

      {providers.map((provider) => {
        const fields = schemas[provider.id] ?? []
        const result = testResult[provider.id]

        return (
          <div key={provider.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">{provider.name}</h4>
              <div className="flex items-center gap-2">
                {result === true && <Check className="h-4 w-4 text-green-500" />}
                {result === false && <X className="h-4 w-4 text-red-500" />}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={testing !== null}
                  onClick={() => handleTest(provider.id)}
                >
                  {testing === provider.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : null}
                  Test connection
                </Button>
              </div>
            </div>

            {fields.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No configuration needed. Uses GitHub CLI authentication by default.
              </p>
            ) : (
              fields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    {field.label}
                    {!field.required && (
                      <span className="text-muted-foreground/50 ml-1">(optional)</span>
                    )}
                  </label>
                  <Input
                    type={field.type === 'password' ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="text-sm h-8"
                  />
                </div>
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Register the Integrations section in SettingsModal**

In `src/renderer/src/components/settings/SettingsModal.tsx`:

Add the import at the top:

```typescript
import { SettingsIntegrations } from './SettingsIntegrations'
import { Plug } from 'lucide-react'
```

Add a new entry to the `SECTIONS` array (add it after the `terminal` entry, before `security`):

```typescript
  { id: 'integrations', label: 'Integrations', icon: Plug, electronOnly: false },
```

Find the section content rendering area (where each section component is conditionally rendered). Add:

```tsx
{activeSection === 'integrations' && <SettingsIntegrations />}
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/SettingsIntegrations.tsx src/renderer/src/components/settings/SettingsModal.tsx
git commit -m "feat(ticket-import): add Integrations settings section with dynamic provider fields"
```

---

## Task 14: Update Kanban Store for External Fields

**Files:**
- Modify: `src/renderer/src/stores/useKanbanStore.ts`

- [ ] **Step 1: Verify types flow through correctly**

The `KanbanTicket` type in `src/main/db/types.ts` now includes `external_provider`, `external_id`, and `external_url`. Since the store uses this type and the IPC bridge returns the full row, the new fields should flow through automatically.

Check that the store's import of `KanbanTicket` (near line 4) still references the correct type:

```typescript
import type {
  KanbanTicket,
  KanbanTicketColumn,
  KanbanTicketCreate,
  KanbanTicketUpdate
} from '../../../main/db/types'
```

This should already be correct. The store calls `window.kanban.ticket.getByProject()` which returns the full ticket objects from the database, and the new columns will be included automatically in the DB response.

- [ ] **Step 2: Add an importTickets convenience method**

This isn't strictly necessary (the modal calls `window.ticketImport.importIssues` directly then reloads), but add a convenience method for refresh after import. In the store's actions (inside the `create` function), add after the `createTicket` method:

```typescript
      // ── refreshAfterImport ──────────────────────────────────────
      refreshAfterImport: async (projectId: string) => {
        // Re-fetch all tickets to pick up newly imported ones
        await get().loadTickets(projectId)
      },
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/stores/useKanbanStore.ts
git commit -m "feat(ticket-import): add refreshAfterImport to kanban store"
```

---

## Task 15: Update GraphQL Kanban Type for External Fields

**Files:**
- Modify: `src/server/schema/types/kanban.graphql`
- Modify: `src/server/resolvers/query/kanban.resolvers.ts`
- Modify: `src/server/resolvers/mutation/kanban.resolvers.ts`
- Modify: `src/renderer/src/transport/graphql/adapters/kanban.ts`

- [ ] **Step 1: Add external fields to GraphQL KanbanTicket type**

In `src/server/schema/types/kanban.graphql`, add these fields to the `KanbanTicket` type (after `updatedAt`):

```graphql
  externalProvider: String
  externalId: String
  externalUrl: String
```

Add the same fields to `KanbanCreateTicketInput` (all optional):

```graphql
  externalProvider: String
  externalId: String
  externalUrl: String
```

- [ ] **Step 2: Update query resolver mapper**

In `src/server/resolvers/query/kanban.resolvers.ts`, find the `mapKanbanTicket` function. Add these fields to the returned object:

```typescript
    externalProvider: row.external_provider ?? null,
    externalId: row.external_id ?? null,
    externalUrl: row.external_url ?? null,
```

- [ ] **Step 3: Update mutation resolver for createTicket**

In `src/server/resolvers/mutation/kanban.resolvers.ts`, find the `kanbanCreateTicket` resolver. Add to the object passed to `ctx.db.createKanbanTicket()`:

```typescript
        external_provider: input.externalProvider ?? null,
        external_id: input.externalId ?? null,
        external_url: input.externalUrl ?? null,
```

- [ ] **Step 4: Update the GraphQL transport adapter**

In `src/renderer/src/transport/graphql/adapters/kanban.ts`:

Add the external fields to the `GqlKanbanTicket` interface:

```typescript
  externalProvider: string | null
  externalId: string | null
  externalUrl: string | null
```

Add to the `mapTicket` function's return object:

```typescript
    external_provider: t.externalProvider,
    external_id: t.externalId,
    external_url: t.externalUrl,
```

Add to the `TICKET_FIELDS` string:

```typescript
const TICKET_FIELDS = `id projectId sessionId worktreeId title description column sortOrder archived createdAt updatedAt externalProvider externalId externalUrl`
```

- [ ] **Step 5: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 6: Commit**

```bash
git add src/server/schema/types/kanban.graphql src/server/resolvers/query/kanban.resolvers.ts src/server/resolvers/mutation/kanban.resolvers.ts src/renderer/src/transport/graphql/adapters/kanban.ts
git commit -m "feat(ticket-import): expose external source fields through GraphQL kanban types"
```

---

## Task 16: Handle Rate Limit Errors in GitHub Provider

**Files:**
- Modify: `src/main/services/ticket-providers/github-provider.ts`

- [ ] **Step 1: Add rate limit detection to ghFetch**

In `src/main/services/ticket-providers/github-provider.ts`, update the `ghFetch` method to detect and annotate rate limit responses:

Find the `ghFetch` method and replace it with:

```typescript
  private async ghFetch(
    url: string,
    token: string,
    init?: RequestInit
  ): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers
      }
    })

    // Check for rate limit
    if (res.status === 403 || res.status === 429) {
      const resetHeader = res.headers.get('x-ratelimit-reset')
      if (resetHeader) {
        const resetTime = parseInt(resetHeader, 10) * 1000 // Convert to ms
        const waitMinutes = Math.ceil((resetTime - Date.now()) / 60000)
        log.warn('GitHub API rate limited', { resetTime, waitMinutes })
        throw new Error(
          `Rate limited by GitHub. Try again in ${waitMinutes > 0 ? `${waitMinutes} minute${waitMinutes > 1 ? 's' : ''}` : 'a moment'}.`
        )
      }
    }

    return res
  }
```

- [ ] **Step 2: Verify the build succeeds**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ticket-providers/github-provider.ts
git commit -m "feat(ticket-import): add rate limit detection with retry-after messaging"
```

---

## Task 17: Final Integration Verification

- [ ] **Step 1: Full build check**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npm run build 2>&1 | tail -20`

The build should succeed with no errors. Warnings are acceptable.

- [ ] **Step 2: Check TypeScript strict mode**

Run: `cd /Users/mor/.hive-worktrees/hive-electron/hive-electron--import-tickets && npx tsc --noEmit 2>&1 | tail -20`

Fix any type errors that surface. Common issues:
- Missing imports
- `as const` assertions
- Nullable fields not handled

- [ ] **Step 3: Verify all new files exist**

Run the following to confirm all expected files were created:

```bash
ls -la src/main/services/ticket-providers/ticket-provider-types.ts \
       src/main/services/ticket-providers/ticket-provider-manager.ts \
       src/main/services/ticket-providers/github-provider.ts \
       src/main/services/ticket-providers/index.ts \
       src/main/ipc/ticket-import-handlers.ts \
       src/server/schema/types/ticket-import.graphql \
       src/server/resolvers/query/ticket-import.resolvers.ts \
       src/server/resolvers/mutation/ticket-import.resolvers.ts \
       src/renderer/src/components/kanban/ImportTicketsModal.tsx \
       src/renderer/src/components/kanban/UpdateStatusModal.tsx \
       src/renderer/src/components/settings/SettingsIntegrations.tsx \
       src/renderer/src/transport/graphql/adapters/ticket-import.ts
```

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix(ticket-import): resolve build/type errors from integration"
```

---

## Manual Testing Checklist

After all tasks are complete, test these scenarios:

1. **Settings > Integrations** — Section appears, shows GitHub with PAT field and "Test connection" button
2. **Test connection** — With `gh` CLI authenticated, clicking "Test connection" shows success
3. **Kanban board** — "Import" button appears in top-right of board header
4. **Import modal** — Opens, auto-detects repo from git remote, shows paginated issues list
5. **Search** — Typing in search box filters issues after debounce
6. **Show closed toggle** — Toggle shows/hides closed issues
7. **Select + import** — Select 2-3 issues, click Import, tickets appear in Todo column
8. **Dedup** — Re-opening import and importing same issues shows "Skipped X duplicates" toast
9. **Provider badge** — Imported tickets show small GitHub icon, clickable to open original issue
10. **Context menu** — Right-click imported ticket shows "Update on GitHub" option
11. **Status update** — Clicking "Update on GitHub" opens picker with Open/Closed, clicking one updates the remote issue
12. **Rate limit** — If rate limited, error toast shows retry time
13. **No GitHub remote** — For a non-GitHub project, import modal shows manual repo entry field
14. **Pagination** — Previous/Next buttons work across pages of issues
