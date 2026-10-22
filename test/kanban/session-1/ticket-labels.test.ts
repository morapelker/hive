import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Project, TicketLabel } from '../../../src/main/db'
import { closeDatabase, getDatabase } from '../../../src/main/db'
import {
  getKanbanBackendForProject,
  moveKanbanTicketToProject
} from '../../../src/main/services/kanban-backend'

/**
 * Ticket labels through the kanban backends: they round-trip on internal and markdown boards,
 * live only in the local runtime row of a markdown card (never in its .md file, which agents
 * read), are copied by duplicate (each one-off re-issued under a new id) and survive a move
 * between backends.
 */
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

const ONCE_ID_RE = /^[0-9a-f-]{36}$/

describeIf('Kanban ticket labels', () => {
  const tempDirs: string[] = []
  let internalProject: Project
  let markdownProject: Project
  let joy: TicketLabel
  let review: TicketLabel
  let oneOff: TicketLabel

  beforeEach(() => {
    const dbDir = mkdtempSync(join(tmpdir(), 'hive-labels-backend-db-'))
    const markdownDir = mkdtempSync(join(tmpdir(), 'hive-labels-md-project-'))
    tempDirs.push(dbDir, markdownDir)
    process.env.HIVE_SERVER_DB_PATH = join(dbDir, 'hive.db')
    closeDatabase()
    const db = getDatabase()
    internalProject = db.createProject({
      name: 'Internal Project',
      path: '/tmp/hive-labels-internal-project'
    })
    markdownProject = db.createProject({ name: 'Markdown Project', path: markdownDir })
    db.updateProjectKanbanStorageMode(markdownProject.id, 'markdown')

    const savedJoy = db.createSavedTicketLabel({ name: 'Waiting for Joy', color: 'yellow' })
    const savedReview = db.createSavedTicketLabel({ name: 'Needs review', color: 'blue' })
    joy = { id: savedJoy.id, kind: 'saved', name: savedJoy.name, color: savedJoy.color }
    review = { id: savedReview.id, kind: 'saved', name: savedReview.name, color: savedReview.color }
    oneOff = { id: 'once-1', kind: 'once', name: 'Waiting until 21/10', color: 'gray' }
  })

  afterEach(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const markdownFolder = (): string => join(markdownProject.path, 'docs', 'kanban')

  const markdownFiles = (): string[] =>
    readdirSync(markdownFolder())
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(markdownFolder(), name))

  /** Every .md file's bytes, so a test can assert none of them changed. */
  const snapshotFiles = (): Map<string, Buffer> =>
    new Map(markdownFiles().map((path) => [path, readFileSync(path)]))

  const expectNoLabelText = (contents: string): void => {
    expect(contents).not.toMatch(/labels/i)
    expect(contents).not.toContain('Waiting for Joy')
    expect(contents).not.toContain('Waiting until 21/10')
  }

  /** Same labels, except that every one-off has a new, distinct id. */
  const expectCopiedLabels = (
    copy: readonly TicketLabel[],
    source: readonly TicketLabel[]
  ): void => {
    expect(copy).toHaveLength(source.length)
    copy.forEach((label, index) => {
      const original = source[index]
      expect({ ...label, id: null }).toEqual({ ...original, id: null })
      if (original.kind === 'saved') expect(label.id).toBe(original.id)
      else {
        expect(label.id).not.toBe(original.id)
        expect(label.id).toMatch(ONCE_ID_RE)
      }
    })
  }

  describe('internal backend', () => {
    it('round-trips labels on create and update', async () => {
      const backend = getKanbanBackendForProject(internalProject.id)
      const created = await backend.create(internalProject.id, {
        project_id: internalProject.id,
        title: 'Labelled',
        labels: [joy, oneOff]
      })
      expect(created.labels).toEqual([joy, oneOff])
      expect((await backend.get(internalProject.id, created.id))?.labels).toEqual([joy, oneOff])

      const updated = await backend.update(internalProject.id, created.id, { labels: [review] })
      expect(updated?.labels).toEqual([review])
      const listed = await backend.list(internalProject.id, false)
      expect(listed.find((ticket) => ticket.id === created.id)?.labels).toEqual([review])

      const plain = await backend.create(internalProject.id, {
        project_id: internalProject.id,
        title: 'Plain'
      })
      expect(plain.labels).toEqual([])
    })

    it('duplicate copies every label and re-issues each one-off under a new id', async () => {
      const backend = getKanbanBackendForProject(internalProject.id)
      const source = await backend.create(internalProject.id, {
        project_id: internalProject.id,
        title: 'Source',
        labels: [joy, review, oneOff]
      })

      const first = await backend.duplicate(internalProject.id, source.id)
      const second = await backend.duplicate(internalProject.id, source.id, { column: 'review' })
      expectCopiedLabels(first.labels ?? [], [joy, review, oneOff])
      expectCopiedLabels(second.labels ?? [], [joy, review, oneOff])
      expect(first.labels?.[2].id).not.toBe(second.labels?.[2].id)
      expect((await backend.get(internalProject.id, source.id))?.labels).toEqual([
        joy,
        review,
        oneOff
      ])

      // The copies are independent: removing the one-off from one leaves the others alone.
      await backend.update(internalProject.id, first.id, { labels: [joy, review] })
      expect((await backend.get(internalProject.id, second.id))?.labels).toEqual(second.labels)
      expect((await backend.get(internalProject.id, source.id))?.labels).toContainEqual(oneOff)
    })
  })

  describe('markdown backend', () => {
    it('keeps labels in the runtime row only: the .md file never changes for a label write', async () => {
      const backend = getKanbanBackendForProject(markdownProject.id)
      const created = await backend.create(markdownProject.id, {
        project_id: markdownProject.id,
        title: 'Markdown card',
        description: 'Body text',
        labels: [joy, oneOff]
      })
      expect(created.labels).toEqual([joy, oneOff])
      const [cardPath] = markdownFiles()
      expectNoLabelText(readFileSync(cardPath, 'utf-8'))

      const before = snapshotFiles()
      const updated = await backend.update(markdownProject.id, created.id, {
        labels: [review, oneOff]
      })
      expect(updated?.labels).toEqual([review, oneOff])
      expect(snapshotFiles()).toEqual(before)

      const listed = await backend.list(markdownProject.id, false)
      expect(listed.find((ticket) => ticket.id === created.id)?.labels).toEqual([review, oneOff])
      const row = getDatabase()
        .getRawDb()
        .prepare(
          'SELECT labels FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?'
        )
        .get(markdownProject.id, created.id) as { labels: string }
      expect(JSON.parse(row.labels)).toEqual([review, oneOff])

      // An unrelated update keeps them.
      await backend.update(markdownProject.id, created.id, { title: 'Renamed card' })
      expect((await backend.get(markdownProject.id, created.id))?.labels).toEqual([review, oneOff])
      expectNoLabelText(readFileSync(markdownFiles()[0], 'utf-8'))

      const plain = await backend.create(markdownProject.id, {
        project_id: markdownProject.id,
        title: 'Plain card'
      })
      expect(plain.labels).toEqual([])
    })

    it('createBatch stores each draft’s labels', async () => {
      const backend = getKanbanBackendForProject(markdownProject.id)
      const result = await backend.createBatch(markdownProject.id, {
        drafts: [
          { draft_key: 'a', project_id: markdownProject.id, title: 'Batch A', labels: [joy] },
          { draft_key: 'b', project_id: markdownProject.id, title: 'Batch B' }
        ]
      })
      expect(result.tickets.map((ticket) => ticket.labels)).toEqual([[joy], []])
      for (const path of markdownFiles()) expectNoLabelText(readFileSync(path, 'utf-8'))
    })

    it('duplicate copies every label with fresh one-off ids, outside the new .md file', async () => {
      const backend = getKanbanBackendForProject(markdownProject.id)
      const source = await backend.create(markdownProject.id, {
        project_id: markdownProject.id,
        title: 'Source card',
        labels: [joy, oneOff]
      })

      const duplicate = await backend.duplicate(markdownProject.id, source.id)
      expectCopiedLabels(duplicate.labels ?? [], [joy, oneOff])
      expectCopiedLabels((await backend.get(markdownProject.id, duplicate.id))?.labels ?? [], [
        joy,
        oneOff
      ])
      expect((await backend.get(markdownProject.id, source.id))?.labels).toEqual([joy, oneOff])
      expect(markdownFiles()).toHaveLength(2)
      for (const path of markdownFiles()) expectNoLabelText(readFileSync(path, 'utf-8'))
    })

    it('serves catalog edits on a cached board (they rewrite the runtime rows behind it)', async () => {
      const backend = getKanbanBackendForProject(markdownProject.id)
      const created = await backend.create(markdownProject.id, {
        project_id: markdownProject.id,
        title: 'Cached card',
        labels: [joy, review]
      })
      expect((await backend.get(markdownProject.id, created.id))?.labels).toEqual([joy, review])
      const before = snapshotFiles()

      getDatabase().updateSavedTicketLabel(joy.id, { name: 'Waiting for Joy Smith' })
      expect((await backend.get(markdownProject.id, created.id))?.labels).toEqual([
        { ...joy, name: 'Waiting for Joy Smith' },
        review
      ])

      getDatabase().reorderSavedTicketLabels([review.id, joy.id])
      expect(
        (await backend.get(markdownProject.id, created.id))?.labels?.map((label) => label.id)
      ).toEqual([review.id, joy.id])

      getDatabase().deleteSavedTicketLabel(review.id)
      expect((await backend.get(markdownProject.id, created.id))?.labels).toEqual([
        { ...joy, name: 'Waiting for Joy Smith' }
      ])
      expect(snapshotFiles()).toEqual(before)
    })
  })

  describe('moves between backends', () => {
    it('internal → markdown keeps every label, one-offs with their ids', async () => {
      const source = await getKanbanBackendForProject(internalProject.id).create(
        internalProject.id,
        { project_id: internalProject.id, title: 'Moving card', labels: [joy, oneOff] }
      )

      const moved = await moveKanbanTicketToProject(
        internalProject.id,
        source.id,
        markdownProject.id
      )
      expect(moved?.project_id).toBe(markdownProject.id)
      expect(moved?.labels).toEqual([joy, oneOff])
      expect(
        (await getKanbanBackendForProject(markdownProject.id).get(markdownProject.id, source.id))
          ?.labels
      ).toEqual([joy, oneOff])
      expectNoLabelText(readFileSync(markdownFiles()[0], 'utf-8'))
    })

    it('markdown → internal keeps every label', async () => {
      const source = await getKanbanBackendForProject(markdownProject.id).create(
        markdownProject.id,
        { project_id: markdownProject.id, title: 'Moving card', labels: [review, oneOff] }
      )

      const moved = await moveKanbanTicketToProject(
        markdownProject.id,
        source.id,
        internalProject.id
      )
      expect(moved?.project_id).toBe(internalProject.id)
      expect(moved?.labels).toEqual([review, oneOff])
      expect(getDatabase().getKanbanTicket(source.id)?.labels).toEqual([review, oneOff])
    })

    it('internal → internal keeps every label', async () => {
      const other = getDatabase().createProject({
        name: 'Other Internal',
        path: '/tmp/hive-labels-other-internal'
      })
      const source = await getKanbanBackendForProject(internalProject.id).create(
        internalProject.id,
        { project_id: internalProject.id, title: 'Moving card', labels: [joy, oneOff] }
      )

      const moved = await moveKanbanTicketToProject(internalProject.id, source.id, other.id)
      expect(moved?.labels).toEqual([joy, oneOff])
    })
  })
})
