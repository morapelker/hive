import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunReport
} from '@shared/types/document-flow'

// Complete rows for component tests; every test overrides only what it is about.

const NOW = '2026-05-04T10:00:00.000Z'

export function makeRun(overrides: Partial<DocumentRun> = {}): DocumentRun {
  return {
    id: 'run-1',
    project_id: 'project-1',
    title: 'Checkout redesign',
    source_path: '/docs/checkout-redesign.html',
    run_dir: '/tmp/document-runs/run-1',
    document_path: '/tmp/document-runs/run-1/document.md',
    status: 'preview',
    error: null,
    config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: 'pnpm check' },
    extraction: {
      documentTitle: 'Checkout redesign',
      numbering: 'A1…A3',
      openQuestions: [],
      warnings: [],
      generatedBy: 'claude-code · haiku',
      textLength: 12000,
      figureCount: 0
    },
    base_branch: null,
    base_sha: null,
    integration_branch: null,
    integration_worktree_id: null,
    integration_worktree_path: null,
    integration_connection_id: null,
    integration_connection_path: null,
    members: null,
    ticket_id: null,
    report: null,
    migration_session_id: null,
    migration_started_at: null,
    migration_owner_pid: null,
    runner_client_id: null,
    runner_heartbeat_at: null,
    created_at: NOW,
    updated_at: NOW,
    started_at: null,
    finished_at: null,
    ...overrides
  }
}

export function makeItem(overrides: Partial<DocumentRunItem> = {}): DocumentRunItem {
  const key = overrides.key ?? 'A1'
  return {
    id: `item-${key}`,
    run_id: 'run-1',
    key,
    position: 0,
    title: `Task ${key}`,
    summary: '',
    description: `Build ${key}.`,
    kind: 'feature',
    depends_on: [],
    has_migration: false,
    size: 'M',
    conflict_risk: 'low',
    doc_status: 'open',
    selected: true,
    figures: [],
    open_questions: [],
    verification_suggested: [],
    verification: [],
    verification_reason: '',
    launch_config: null,
    status: 'pending',
    status_detail: null,
    ticket_id: null,
    worktree_id: null,
    connection_id: null,
    members: null,
    session_id: null,
    fix_ticket_id: null,
    fix_session_id: null,
    branch_name: null,
    verdict: null,
    nudge_count: 0,
    conflict_attempts: 0,
    conflict_head: null,
    fix_attempts: 0,
    continue_attempts: 0,
    pre_merge_sha: null,
    merge_sha: null,
    last_prompt_at: null,
    last_checked_at: null,
    retry_at: null,
    wait_until: null,
    wait_timeouts: 0,
    created_at: NOW,
    updated_at: NOW,
    started_at: null,
    finished_at: null,
    ...overrides
  }
}

export function makeDetail(
  run: Partial<DocumentRun> = {},
  items: Partial<DocumentRunItem>[] = [{ key: 'A1' }, { key: 'A2' }, { key: 'A3' }]
): DocumentRunDetail {
  return {
    run: makeRun(run),
    items: items.map((item, position) =>
      makeItem({ position, run_id: run.id ?? 'run-1', ...item })
    ),
    events: []
  }
}

export function makeReport(overrides: Partial<DocumentRunReport> = {}): DocumentRunReport {
  return {
    generatedAt: NOW,
    integrationBranch: 'doc-checkout-redesign',
    integrationWorktreePath: '/worktrees/shop--doc-checkout-redesign',
    baseBranch: 'main',
    baseSha: '1111111aaaaaaa',
    headSha: '2222222bbbbbbb',
    baseMoved: false,
    merged: [],
    unmerged: [],
    migrations: [],
    manualSteps: [],
    stats: { filesChanged: 12, insertions: 340, deletions: 25, commits: 9 },
    verify: null,
    ...overrides
  }
}

export const TEST_PROJECT = {
  id: 'project-1',
  name: 'Shop',
  path: '/repo/shop',
  kind: 'git'
} as const
