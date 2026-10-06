import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DOCUMENT_RUN_TICKET_PROVIDER, documentRunIdOf } from '@shared/document-flow/run-ticket'
import { closeDatabase, getDatabase } from '../../db'
import type { Project } from '../../db'
import { getKanbanBackendForProject, moveKanbanTicketToProject } from '../kanban-backend'

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

/**
 * The ticket of a document run is an ordinary ticket marked through the external-source
 * fields and attached to the run's integration worktree. Both board backends have to store
 * that from a batch create (how the document flow creates it) and hand it back, or the board
 * could not tell it from a ticket to launch.
 */
describeIf('document run ticket on both board backends', () => {
  const tempDirs: string[] = []
  let internalProject: Project
  let markdownProject: Project

  beforeEach(() => {
    const dbDir = mkdtempSync(join(tmpdir(), 'hive-run-ticket-db-'))
    const markdownDir = mkdtempSync(join(tmpdir(), 'hive-run-ticket-md-'))
    tempDirs.push(dbDir, markdownDir)

    process.env.HIVE_SERVER_DB_PATH = join(dbDir, 'hive.db')
    closeDatabase()
    const db = getDatabase()
    internalProject = db.createProject({
      name: 'Internal Project',
      path: '/tmp/hive-run-ticket-internal'
    })
    markdownProject = db.createProject({ name: 'Markdown Project', path: markdownDir })
    db.updateProjectKanbanStorageMode(markdownProject.id, 'markdown')
  })

  afterEach(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const createRunTicket = async (project: Project): Promise<{ id: string; worktreeId: string }> => {
    const worktree = getDatabase().createWorktree({
      project_id: project.id,
      name: 'doc-checkout',
      branch_name: 'doc-checkout',
      path: `${project.path}--doc-checkout`,
      base_branch: 'main'
    })
    const { tickets } = await getKanbanBackendForProject(project.id).createBatch(project.id, {
      drafts: [
        {
          draft_key: 'run-run-1',
          project_id: project.id,
          title: 'Checkout redesign',
          description: 'Document run of /docs/checkout.html.',
          column: 'in_progress',
          mode: null,
          worktree_id: worktree.id,
          external_provider: DOCUMENT_RUN_TICKET_PROVIDER,
          external_id: 'run-1',
          // The document the run was made from: on the ticket row, for when the run is gone.
          external_url: '/docs/checkout.html'
        }
      ]
    })
    return { id: tickets[0].id, worktreeId: worktree.id }
  }

  it.each(['internal', 'markdown'] as const)(
    'stores and reads back the run ticket on the %s backend',
    async (mode) => {
      const project = mode === 'internal' ? internalProject : markdownProject
      const backend = getKanbanBackendForProject(project.id)

      const { id, worktreeId } = await createRunTicket(project)

      const stored = await backend.get(project.id, id)
      expect(stored).toMatchObject({
        title: 'Checkout redesign',
        column: 'in_progress',
        mode: null,
        current_session_id: null,
        worktree_id: worktreeId,
        external_provider: 'document-run',
        external_id: 'run-1',
        external_url: '/docs/checkout.html'
      })
      expect(documentRunIdOf(stored)).toBe('run-1')
      // Listed like any ticket: it is one.
      expect((await backend.list(project.id, false)).map((ticket) => ticket.id)).toEqual([id])

      // The move the document flow makes when the run ends.
      const moved = await backend.move(project.id, id, 'review', -1)
      expect(moved).toMatchObject({
        column: 'review',
        unread: true,
        worktree_id: worktreeId,
        external_url: '/docs/checkout.html'
      })
      expect(documentRunIdOf(moved)).toBe('run-1')

      // Archiving the integration worktree from the merge dialog detaches it.
      await backend.detachWorktree(worktreeId)
      const detached = await backend.get(project.id, id)
      expect(detached?.worktree_id).toBeNull()
      expect(documentRunIdOf(detached)).toBe('run-1')

      expect(await backend.delete(project.id, id)).toBe(true)
      expect(await backend.get(project.id, id)).toBeNull()
    }
  )

  it.each(['internal', 'markdown'] as const)(
    'does not carry the run marker onto a duplicate on the %s backend',
    async (mode) => {
      const project = mode === 'internal' ? internalProject : markdownProject
      const { id } = await createRunTicket(project)

      const copy = await getKanbanBackendForProject(project.id).duplicate(project.id, id)

      expect(copy.id).not.toBe(id)
      expect(documentRunIdOf(copy)).toBeNull()
      expect(copy.worktree_id).toBeNull()
    }
  )

  it.each([
    ['internal', 'internal'],
    ['internal', 'markdown'],
    ['markdown', 'internal']
  ] as const)('refuses to move the run ticket from an %s to another %s project', async (from, to) => {
    const source = from === 'internal' ? internalProject : markdownProject
    const target =
      to === from
        ? getDatabase().createProject({ name: 'Other', path: '/tmp/hive-run-ticket-other' })
        : to === 'internal'
          ? internalProject
          : markdownProject
    const { id } = await createRunTicket(source)

    await expect(moveKanbanTicketToProject(source.id, id, target.id)).rejects.toThrow(
      'The ticket of a document run cannot be moved to another project.'
    )

    expect(await getKanbanBackendForProject(source.id).get(source.id, id)).not.toBeNull()
    expect(await getKanbanBackendForProject(target.id).list(target.id, true)).toEqual([])
  })
})
