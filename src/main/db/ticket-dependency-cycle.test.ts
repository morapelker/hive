import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from './database'

// `addTicketDependency(dependent, blocker)`: the dependent waits for the blocker. An edge closes
// a loop only when the blocker already waits (directly or through others) for the dependent.

const tempDirs: string[] = []

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const setup = (): { db: DatabaseService; a: string; b: string; c: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'tedooo-code-ticket-cycle-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
  const [a, b, c] = ['A', 'B', 'C'].map(
    (title) => db.createKanbanTicket({ project_id: project.id, title }).id
  )
  return { db, a, b, c }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CIRCULAR = {
  success: false,
  error: 'Adding this dependency would create a circular dependency'
}

describeIf('addTicketDependency cycle check', () => {
  it('refuses the reverse of an existing edge', () => {
    const { db, a, b } = setup()
    expect(db.addTicketDependency(a, b)).toEqual({ success: true })
    expect(db.addTicketDependency(b, a)).toEqual(CIRCULAR)
  })

  it('refuses an edge that closes a longer loop', () => {
    const { db, a, b, c } = setup()
    expect(db.addTicketDependency(a, b)).toEqual({ success: true })
    expect(db.addTicketDependency(b, c)).toEqual({ success: true })
    expect(db.addTicketDependency(c, a)).toEqual(CIRCULAR)
  })

  it('accepts a redundant edge alongside a chain', () => {
    const { db, a, b, c } = setup()
    expect(db.addTicketDependency(a, b)).toEqual({ success: true })
    expect(db.addTicketDependency(b, c)).toEqual({ success: true })
    expect(db.addTicketDependency(a, c)).toEqual({ success: true })
    expect(
      db
        .getBlockersForTicket(a)
        .map((ticket) => ticket.id)
        .sort()
    ).toEqual([b, c].sort())
  })

  it('accepts an edge that already exists and refuses a self edge', () => {
    const { db, a, b } = setup()
    expect(db.addTicketDependency(a, b)).toEqual({ success: true })
    expect(db.addTicketDependency(a, b)).toEqual({ success: true })
    expect(db.addTicketDependency(a, a)).toEqual({
      success: false,
      error: 'A ticket cannot depend on itself'
    })
  })
})
