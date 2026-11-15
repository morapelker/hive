// The rule of the sidebar's Recent section (which projects, in what order), the age text of a
// row, and the one agent state shown for a whole project.

import { describe, expect, it } from 'vitest'
import {
  RECENT_PROJECT_LIMIT,
  formatOpenedAge,
  pickRecentProjects,
  summarizeAgentState
} from './recent-projects'

const T0 = Date.parse('2026-03-01T12:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const at = (minutesAgo: number): string => new Date(T0 - minutesAgo * MINUTE).toISOString()

const git = (id: string, minutesAgo: number, kind?: 'git' | 'connection') => ({
  id,
  ...(kind ? { kind } : {}),
  last_accessed_at: at(minutesAgo)
})

const database = (id: string, minutesAgo: number, pinned = false) => ({
  id,
  pinned,
  lastAccessedAt: at(minutesAgo)
})

const ids = (entries: Array<{ id: string }>): string[] => entries.map((entry) => entry.id)

describe('pickRecentProjects', () => {
  it('lists the five most recently opened projects, newest first', () => {
    const projects = [
      git('p-40', 40),
      git('p-10', 10),
      git('p-70', 70),
      git('p-20', 20),
      git('p-60', 60),
      git('p-30', 30),
      git('p-50', 50)
    ]

    const recent = pickRecentProjects(projects, [], new Set())

    expect(RECENT_PROJECT_LIMIT).toBe(5)
    expect(ids(recent)).toEqual(['p-10', 'p-20', 'p-30', 'p-40', 'p-50'])
    expect(recent[0].openedAt).toBe(T0 - 10 * MINUTE)
  })

  it('leaves out every pinned project and fills the row with the next most recent one', () => {
    const projects = [
      git('p-10', 10),
      git('p-20', 20),
      git('p-30', 30),
      git('p-40', 40),
      git('p-50', 50),
      git('p-60', 60)
    ]

    expect(ids(pickRecentProjects(projects, [], new Set(['p-20'])))).toEqual([
      'p-10',
      'p-30',
      'p-40',
      'p-50',
      'p-60'
    ])
  })

  it('counts every kind: git projects, connection projects and databases', () => {
    const recent = pickRecentProjects(
      [git('repo', 30), git('stack', 10, 'connection')],
      [database('db', 20)],
      new Set()
    )

    expect(recent.map((entry) => [entry.kind, entry.id])).toEqual([
      ['project', 'stack'],
      ['data', 'db'],
      ['project', 'repo']
    ])
  })

  it('leaves out a pinned connection project and a pinned database', () => {
    const recent = pickRecentProjects(
      [git('repo', 30), git('stack', 10, 'connection')],
      [database('db', 20, true), database('db-2', 40)],
      new Set(['stack'])
    )

    expect(ids(recent)).toEqual(['repo', 'db-2'])
  })

  it('takes no Space into account: its input is every project, whatever Space it is in', () => {
    // The rule has no Space parameter. A project of another Space is a project like any other.
    const inMobileSpace = git('seller-ios', 5)
    const inNoSpace = git('docs-site', 15)

    expect(ids(pickRecentProjects([inNoSpace, inMobileSpace], [], new Set()))).toEqual([
      'seller-ios',
      'docs-site'
    ])
  })

  it('shows fewer than five rows when fewer projects qualify, and none when none do', () => {
    expect(ids(pickRecentProjects([git('a', 1), git('b', 2)], [], new Set()))).toEqual(['a', 'b'])
    expect(pickRecentProjects([git('a', 1)], [database('db', 2, true)], new Set(['a']))).toEqual([])
    expect(pickRecentProjects([], [], new Set())).toEqual([])
  })

  it('keeps the given order between projects opened at the same instant', () => {
    const recent = pickRecentProjects([git('first', 5), git('second', 5)], [], new Set())
    expect(ids(recent)).toEqual(['first', 'second'])
  })

  it('puts a project with an unreadable time last', () => {
    const recent = pickRecentProjects(
      [{ id: 'broken', last_accessed_at: 'not a date' }, git('ok', 500)],
      [],
      new Set()
    )
    expect(ids(recent)).toEqual(['ok', 'broken'])
  })
})

describe('formatOpenedAge', () => {
  it('reads "now" under a minute', () => {
    expect(formatOpenedAge(T0, T0)).toBe('now')
    expect(formatOpenedAge(T0 - 59_000, T0)).toBe('now')
  })

  it('reads minutes, hours and days', () => {
    expect(formatOpenedAge(T0 - 5 * MINUTE, T0)).toBe('5m')
    expect(formatOpenedAge(T0 - 59 * MINUTE, T0)).toBe('59m')
    expect(formatOpenedAge(T0 - 2 * HOUR, T0)).toBe('2h')
    expect(formatOpenedAge(T0 - 23 * HOUR - 59 * MINUTE, T0)).toBe('23h')
    expect(formatOpenedAge(T0 - 3 * DAY, T0)).toBe('3d')
  })

  it('reads "now" for a project opened after the clock last ticked', () => {
    expect(formatOpenedAge(T0 + 20_000, T0)).toBe('now')
  })
})

describe('summarizeAgentState', () => {
  it('is null when no worktree is working or waiting on the user', () => {
    expect(summarizeAgentState([])).toBeNull()
    expect(summarizeAgentState([null, 'completed', 'unread'])).toBeNull()
  })

  it('is "working" when a worktree is working or planning', () => {
    expect(summarizeAgentState([null, 'working'])).toBe('working')
    expect(summarizeAgentState(['planning', 'completed'])).toBe('working')
  })

  it('is "question" when a worktree waits on the user, even while another works', () => {
    for (const waiting of ['answering', 'permission', 'command_approval', 'plan_ready']) {
      expect(summarizeAgentState(['working', waiting])).toBe('question')
    }
  })
})
