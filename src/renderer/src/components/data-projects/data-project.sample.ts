// Test fixtures for the data project shell (store, sidebar, view, wizard tests).

import type { DataProject } from '@shared/data-projects/types'

export function sampleDataProject(overrides: Partial<DataProject> = {}): DataProject {
  return {
    id: 'dp-1',
    name: 'shop @ localhost',
    engine: 'postgres',
    config: { host: 'localhost', port: 5432, database: 'shop', user: 'postgres' },
    icon: null,
    iconColor: null,
    environment: 'local',
    color: null,
    safeMode: 'off',
    defaultLimit: 1000,
    allowAiDataAccess: false,
    pinned: false,
    secretState: 'stored',
    sortOrder: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastAccessedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  }
}

/** A git project row as useProjectStore holds it. */
export function sampleGitProject(
  id: string,
  sortOrder: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    name: id,
    path: `/repo/${id}`,
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    detected_icon: 'none',
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false,
    sort_order: sortOrder,
    created_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
