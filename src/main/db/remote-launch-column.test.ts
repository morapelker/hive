import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from './database'

const tempDirs: string[] = []
let databaseLoadError: Error | null = null

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch (error) {
    databaseLoadError = error as Error
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-remote-launch-db-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describeIf('sessions.remote_launch column', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('round-trips remote_launch JSON set at creation time', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    const project = db.createProject({ name: 'repo', path: join(tmpdir(), 'repo-a') })
    const remoteLaunch = JSON.stringify({
      role: 'client',
      url: 'https://remote.example.com',
      remoteSessionId: 'remote-session-1',
      remoteWorktreeId: 'remote-worktree-1',
      remoteProjectId: 'remote-project-1',
      tmuxSession: 'hive-1',
      branch: 'feature/x',
      worktreePath: '/tmp/remote-worktree',
      launchedAt: '2026-07-09T00:00:00.000Z'
    })

    const created = db.createSession({
      worktree_id: null,
      project_id: project.id,
      remote_launch: remoteLaunch
    })

    expect(created.remote_launch).toBe(remoteLaunch)
    expect(db.getSession(created.id)?.remote_launch).toBe(remoteLaunch)

    db.close()
  })

  it('defaults remote_launch to null when not provided at creation time', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    const project = db.createProject({ name: 'repo', path: join(tmpdir(), 'repo-b') })
    const created = db.createSession({ worktree_id: null, project_id: project.id })

    expect(created.remote_launch).toBeNull()
    expect(db.getSession(created.id)?.remote_launch).toBeNull()

    db.close()
  })

  it('updateSession sets and clears remote_launch', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    const project = db.createProject({ name: 'repo', path: join(tmpdir(), 'repo-c') })
    const session = db.createSession({ worktree_id: null, project_id: project.id })
    expect(session.remote_launch).toBeNull()

    const hostInfo = JSON.stringify({
      role: 'host',
      launchId: 'launch-abc',
      tmuxSession: 'hive-2',
      promptFile: '/tmp/prompt.txt'
    })

    const updated = db.updateSession(session.id, { remote_launch: hostInfo })
    expect(updated?.remote_launch).toBe(hostInfo)
    expect(db.getSession(session.id)?.remote_launch).toBe(hostInfo)

    const cleared = db.updateSession(session.id, { remote_launch: null })
    expect(cleared?.remote_launch).toBeNull()
    expect(db.getSession(session.id)?.remote_launch).toBeNull()

    db.close()
  })

  it('findSessionByRemoteLaunchId finds by embedded launchId and role, ignoring non-matches', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    const project = db.createProject({ name: 'repo', path: join(tmpdir(), 'repo-d') })

    const target = db.createSession({
      worktree_id: null,
      project_id: project.id,
      remote_launch: JSON.stringify({
        role: 'host',
        launchId: 'launch-xyz',
        tmuxSession: null,
        promptFile: null
      })
    })

    // Session with a different launchId in its JSON.
    db.createSession({
      worktree_id: null,
      project_id: project.id,
      remote_launch: JSON.stringify({
        role: 'host',
        launchId: 'launch-other',
        tmuxSession: null,
        promptFile: null
      })
    })

    // Session whose remote_launch is null.
    db.createSession({ worktree_id: null, project_id: project.id })

    // Session whose remote_launch JSON lacks a launchId field entirely.
    db.createSession({
      worktree_id: null,
      project_id: project.id,
      remote_launch: JSON.stringify({ role: 'client', url: 'https://example.com' })
    })

    // Client-role session sharing the target's launchId (self-launch: host
    // and client rows live in the same DB) — the role filter must keep the
    // two lookups from returning each other's row.
    const clientTarget = db.createSession({
      worktree_id: null,
      project_id: project.id,
      remote_launch: JSON.stringify({
        role: 'client',
        launchId: 'launch-xyz',
        url: 'https://example.com'
      })
    })

    const found = db.findSessionByRemoteLaunchId('launch-xyz', 'host')
    expect(found?.id).toBe(target.id)

    const foundClient = db.findSessionByRemoteLaunchId('launch-xyz', 'client')
    expect(foundClient?.id).toBe(clientTarget.id)

    expect(db.findSessionByRemoteLaunchId('does-not-exist', 'host')).toBeNull()

    db.close()
  })

  it('applies the remote_launch column migration idempotently across re-init', () => {
    const dbPath = makeDbPath()

    const first = new DatabaseService(dbPath)
    first.init()
    first.close()

    // Re-instantiating against the same file must not throw on the
    // idempotent safeAddColumn() call for sessions.remote_launch.
    const second = new DatabaseService(dbPath)
    expect(() => second.init()).not.toThrow()
    second.close()
  })
})
