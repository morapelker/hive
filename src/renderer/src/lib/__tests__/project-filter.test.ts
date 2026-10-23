import { describe, it, expect } from 'vitest'
import {
  filterProjects,
  filterSidebarEntries,
  mergeSidebarEntries,
  reorderGitEntries,
  type ProjectFilterCriteria
} from '../project-filter'

const projects = [
  { id: 'a', name: 'alpha', path: '/code/alpha', language: 'typescript' },
  { id: 'b', name: 'beta', path: '/code/beta', language: 'python' },
  { id: 'c', name: 'gamma', path: '/work/gamma', language: null }
]

const base = { filterQuery: '', activeLanguages: [], activeSpaceId: null, projectSpaceMap: {} }

describe('filterProjects', () => {
  it('returns every project unmatched when there is no filter', () => {
    const result = filterProjects(projects, base)
    expect(result.map((r) => r.project.id)).toEqual(['a', 'b', 'c'])
    expect(result[0].nameMatch).toBeNull()
  })

  it('matches by name or path subsequence and sorts name matches first', () => {
    const result = filterProjects(projects, { ...base, filterQuery: 'wrk' })
    expect(result.map((r) => r.project.id)).toEqual(['c'])
    expect(result[0].pathMatch?.matched).toBe(true)

    const byName = filterProjects(projects, { ...base, filterQuery: 'a' })
    expect(byName[0].project.id).not.toBe('c')
    expect(byName.map((r) => r.project.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('applies language and space filters before the query', () => {
    expect(
      filterProjects(projects, { ...base, activeLanguages: ['python'] }).map((r) => r.project.id)
    ).toEqual(['b'])
    expect(
      filterProjects(projects, {
        ...base,
        activeSpaceId: 's1',
        projectSpaceMap: { a: ['s1'], c: ['s2'] },
        filterQuery: 'a'
      }).map((r) => r.project.id)
    ).toEqual(['a'])
  })
})

describe('filterSidebarEntries', () => {
  const git = [
    { id: 'pa', name: 'alpha', path: '/code/alpha', language: 'typescript', sort_order: 1 },
    { id: 'pb', name: 'beta', path: '/code/beta', language: 'python', sort_order: 2 }
  ]
  const data = [
    { id: 'd1', name: 'orders-db', engine: 'postgres', host: 'db.internal', sortOrder: 0 },
    { id: 'd2', name: 'cache', engine: 'mysql', host: 'localhost', sortOrder: 3 }
  ]
  const entries = mergeSidebarEntries(git, data)
  const describe_ = (d: (typeof data)[number]): string => d.host

  it('keeps the merged order of both kinds without a filter', () => {
    expect(filterSidebarEntries(entries, base, describe_).map((r) => r.project.id)).toEqual([
      'd1',
      'pa',
      'pb',
      'd2'
    ])
  })

  it('matches data projects on name or target, uses the engine as language, lists them in every space', () => {
    const ids = (criteria: Partial<ProjectFilterCriteria>): string[] =>
      filterSidebarEntries(entries, { ...base, ...criteria }, describe_).map((r) => r.project.id)
    expect(ids({ filterQuery: 'internal' })).toEqual(['d1'])
    expect(ids({ activeLanguages: ['mysql', 'python'] })).toEqual(['pb', 'd2'])
    expect(ids({ activeSpaceId: 's1', projectSpaceMap: { pa: ['s1'] } })).toEqual([
      'd1',
      'pa',
      'd2'
    ])
  })
})

describe('reorderGitEntries', () => {
  const entries = [
    { kind: 'data' as const, id: 'D1' },
    { kind: 'project' as const, id: 'Pa' },
    { kind: 'project' as const, id: 'Pb' },
    { kind: 'data' as const, id: 'D2' },
    { kind: 'project' as const, id: 'Pc' }
  ]

  it('refills the git slots in the new order and leaves data projects where they are', () => {
    expect(reorderGitEntries(entries, ['Pc', 'Pa', 'Pb']).map((e) => e.id)).toEqual([
      'D1',
      'Pc',
      'Pa',
      'D2',
      'Pb'
    ])
  })

  it('keeps git projects missing from the order after the ordered ones and ignores unknown ids', () => {
    expect(reorderGitEntries(entries, ['Pb', 'gone']).map((e) => e.id)).toEqual([
      'D1',
      'Pb',
      'Pa',
      'D2',
      'Pc'
    ])
  })
})
