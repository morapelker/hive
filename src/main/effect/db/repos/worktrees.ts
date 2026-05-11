import { randomUUID } from 'crypto'
import { Effect } from 'effect'

import type { Worktree, WorktreeCreate, WorktreeUpdate } from '../../../db/types'
import type { DbError } from '../errors'
import { Db } from '../service'

const mapRow = (row: Record<string, unknown>): Worktree =>
  ({
    ...row,
    is_default: !!row.is_default,
    branch_renamed: (row.branch_renamed as number) ?? 0,
    last_message_at: (row.last_message_at as number) ?? null,
    session_titles: (row.session_titles as string) ?? '[]',
    last_model_provider_id: (row.last_model_provider_id as string) ?? null,
    last_model_id: (row.last_model_id as string) ?? null,
    last_model_variant: (row.last_model_variant as string) ?? null,
    attachments: (row.attachments as string) ?? '[]',
    pinned: (row.pinned as number) ?? 0,
    context: (row.context as string) ?? null,
    github_pr_number: (row.github_pr_number as number) ?? null,
    github_pr_url: (row.github_pr_url as string) ?? null,
    base_branch: (row.base_branch as string) ?? null
  }) as Worktree

const create = (data: WorktreeCreate): Effect.Effect<Worktree, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const now = new Date().toISOString()
    const isDefault = data.is_default ?? false
    const worktree: Worktree = {
      id: randomUUID(),
      project_id: data.project_id,
      name: data.name,
      branch_name: data.branch_name,
      path: data.path,
      status: 'active',
      is_default: isDefault,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      attachments: '[]',
      pinned: 0,
      context: null,
      github_pr_number: null,
      github_pr_url: null,
      base_branch: data.base_branch ?? null,
      created_at: now,
      last_accessed_at: now
    }

    yield* db.exec(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, branch_renamed, base_branch, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        worktree.id,
        worktree.project_id,
        worktree.name,
        worktree.branch_name,
        worktree.path,
        worktree.status,
        isDefault ? 1 : 0,
        worktree.branch_renamed,
        worktree.base_branch,
        worktree.created_at,
        worktree.last_accessed_at
      ]
    )

    return worktree
  })

const get = (id: string): Effect.Effect<Worktree | null, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const row = yield* db.queryOne<Record<string, unknown>>('SELECT * FROM worktrees WHERE id = ?', [id])
    return row ? mapRow(row) : null
  })

const getByPath = (path: string): Effect.Effect<Worktree | null, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const row = yield* db.queryOne<Record<string, unknown>>(
      "SELECT * FROM worktrees WHERE path = ? AND status = 'active'",
      [path]
    )
    return row ? mapRow(row) : null
  })

const getByProject = (projectId: string): Effect.Effect<Worktree[], DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db.query<Record<string, unknown>>(
      'SELECT * FROM worktrees WHERE project_id = ? ORDER BY is_default ASC, last_accessed_at DESC',
      [projectId]
    )
    return rows.map(mapRow)
  })

const getActiveByProject = (projectId: string): Effect.Effect<Worktree[], DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db.query<Record<string, unknown>>(
      "SELECT * FROM worktrees WHERE project_id = ? AND status = 'active' ORDER BY is_default ASC, last_accessed_at DESC",
      [projectId]
    )
    return rows.map(mapRow)
  })

const update = (
  id: string,
  data: WorktreeUpdate
): Effect.Effect<Worktree | null, DbError, Db> =>
  Effect.gen(function* () {
    const existing = yield* get(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.branch_name !== undefined) {
      updates.push('branch_name = ?')
      values.push(data.branch_name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.branch_renamed !== undefined) {
      updates.push('branch_renamed = ?')
      values.push(data.branch_renamed)
    }
    if (data.last_message_at !== undefined) {
      updates.push('last_message_at = ?')
      values.push(data.last_message_at)
    }
    if (data.last_model_provider_id !== undefined) {
      updates.push('last_model_provider_id = ?')
      values.push(data.last_model_provider_id)
    }
    if (data.last_model_id !== undefined) {
      updates.push('last_model_id = ?')
      values.push(data.last_model_id)
    }
    if (data.last_model_variant !== undefined) {
      updates.push('last_model_variant = ?')
      values.push(data.last_model_variant)
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?')
      values.push(data.pinned)
    }
    if (data.github_pr_number !== undefined) {
      updates.push('github_pr_number = ?')
      values.push(data.github_pr_number)
    }
    if (data.github_pr_url !== undefined) {
      updates.push('github_pr_url = ?')
      values.push(data.github_pr_url)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }
    if (updates.length === 0) return existing

    const db = yield* Db
    values.push(id)
    yield* db.exec(`UPDATE worktrees SET ${updates.join(', ')} WHERE id = ?`, values)
    return yield* get(id)
  })

const archive = (id: string): Effect.Effect<Worktree | null, DbError, Db> =>
  update(id, { status: 'archived' })

const remove = (id: string): Effect.Effect<boolean, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const result = yield* db.exec('DELETE FROM worktrees WHERE id = ?', [id])
    return result.changes > 0
  })

const touch = (id: string): Effect.Effect<void, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const now = new Date().toISOString()
    yield* db.exec('UPDATE worktrees SET last_accessed_at = ? WHERE id = ?', [now, id])
  })

const updateContext = (
  worktreeId: string,
  context: string | null
): Effect.Effect<void, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.exec('UPDATE worktrees SET context = ? WHERE id = ?', [context, worktreeId])
  })

export const worktreeRepo = {
  create,
  get,
  getByPath,
  getByProject,
  getActiveByProject,
  update,
  archive,
  delete: remove,
  touch,
  updateContext
}
