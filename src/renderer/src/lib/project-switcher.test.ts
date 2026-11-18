import { describe, expect, it } from 'vitest'
import {
  MATCH_KIND,
  MATCH_TIER,
  formatOpenedAge,
  groupSwitcherProjects,
  matchText,
  parseOpenedAt,
  pinnedSwitcherKeys,
  rankSwitcherProjects,
  shortenHomePath,
  switcherAgentState,
  switcherKey,
  type SwitcherProject,
  type SwitcherProjectKind
} from './project-switcher'

function project(
  name: string,
  lastOpenedAt = 0,
  extra: { kind?: SwitcherProjectKind; path?: string } = {}
): SwitcherProject {
  const kind = extra.kind ?? 'git'
  return {
    key: switcherKey(kind, name),
    kind,
    id: name,
    name,
    path: extra.path ?? `~/code/${name}`,
    lastOpenedAt
  }
}

const names = (list: readonly { name: string }[]): string[] => list.map((p) => p.name)
const rankedNames = (projects: SwitcherProject[], query: string): string[] =>
  rankSwitcherProjects(projects, query).map((m) => m.project.name)

/** The matched characters as text, the way the row highlights them. */
const highlighted = (text: string, indices: number[]): string =>
  indices.map((i) => text[i]).join('')

describe('matchText', () => {
  it('tells an exact name from a prefix, a word start, a run inside a word and scattered letters', () => {
    expect(matchText('ledger', 'ledger')?.tier).toBe(MATCH_TIER.exact)
    expect(matchText('ledg', 'ledger-worker')?.tier).toBe(MATCH_TIER.prefix)
    expect(matchText('work', 'ledger-worker')?.tier).toBe(MATCH_TIER.word)
    expect(matchText('api', 'checkoutApi')?.tier).toBe(MATCH_TIER.word)
    expect(matchText('edge', 'ledger-worker')?.tier).toBe(MATCH_TIER.substring)
    expect(matchText('lgwk', 'ledger-worker')?.tier).toBe(MATCH_TIER.scattered)
    expect(matchText('xyz', 'ledger-worker')).toBeNull()
  })

  it('ignores case and surrounding spaces', () => {
    expect(matchText('  LEDG ', 'Ledger-Worker')).toEqual({
      tier: MATCH_TIER.prefix,
      gaps: 0,
      indices: [0, 1, 2, 3]
    })
  })

  it('prefers the occurrence that starts a word over an earlier one inside a word', () => {
    // "api" is inside "rapid" (index 1) and starts the last word (index 6).
    expect(matchText('api', 'rapid-api')).toEqual({
      tier: MATCH_TIER.word,
      gaps: 0,
      indices: [6, 7, 8]
    })
  })

  it('finds the tightest scattered match, not the first one', () => {
    // Greedy from the first "a" would take a(1)…p(9)…i(11); "api" itself is at 9..11, which
    // is caught as a word. A real scattered case: "wkr" in "work-worker".
    const match = matchText('wkr', 'work-worker')
    expect(match?.tier).toBe(MATCH_TIER.scattered)
    expect(match?.indices).toEqual([5, 8, 10])
    expect(match?.gaps).toBe(3)
  })

  it('lets a space in the query stand for whatever separates two words', () => {
    const match = matchText('check api', 'checkout-api')
    expect(match?.tier).toBe(MATCH_TIER.scattered)
    expect(highlighted('checkout-api', match!.indices)).toBe('checkapi')
  })

  it('matches nothing for an empty query or a single scattered letter that is not there', () => {
    expect(matchText('', 'ledger')).toBeNull()
    expect(matchText('   ', 'ledger')).toBeNull()
    expect(matchText('z', 'ledger')).toBeNull()
  })
})

describe('rankSwitcherProjects', () => {
  it('ranks projects opened at the same time by how closely the text matches', () => {
    // Exact, then prefix, then word start, then inside a word, then scattered.
    const projects = [
      project('alpha-beta-pilot'), // scattered: a…p…i
      project('rapids'), // inside a word
      project('checkout-api'), // starts a word
      project('api-gateway'), // prefix
      project('api') // exact
    ]
    expect(rankedNames(projects, 'api')).toEqual([
      'api',
      'api-gateway',
      'checkout-api',
      'rapids',
      'alpha-beta-pilot'
    ])
  })

  it('puts a tighter scattered match before a looser one opened at the same time', () => {
    const projects = [project('l-o-n-g-e-d-g'), project('lxexdxg')]
    // "ledg": gaps of 3 in "lxexdxg", more in the other.
    expect(rankedNames(projects, 'ledg')).toEqual(['lxexdxg', 'l-o-n-g-e-d-g'])
  })

  it('lists the more recently opened project first among names the text starts', () => {
    const projects = [
      project('ledger-api', 100),
      project('ledger-worker', 300),
      project('ledger-core', 200)
    ]
    expect(rankedNames(projects, 'ledg')).toEqual(['ledger-worker', 'ledger-core', 'ledger-api'])
  })

  it('lets recency decide between the start of the name and the start of a later word', () => {
    // "pa" starts "paste-typer" and only a later word of "tedooo-pa", which was opened last.
    const projects = [
      project('paste-typer', 100),
      project('pa-tools', 50),
      project('tedooo-pa', 900),
      project('checkoutPages', 400)
    ]
    expect(rankedNames(projects, 'pa')).toEqual([
      'tedooo-pa',
      'checkoutPages',
      'paste-typer',
      'pa-tools'
    ])
    expect(rankSwitcherProjects(projects, 'pa').map((m) => m.score)).toEqual([
      MATCH_KIND.start,
      MATCH_KIND.start,
      MATCH_KIND.start,
      MATCH_KIND.start
    ])
  })

  it('keeps an exact name on top, whatever was opened last', () => {
    const projects = [project('api-gateway', 900), project('checkout-api', 800), project('api', 1)]
    expect(rankedNames(projects, 'api')).toEqual(['api', 'api-gateway', 'checkout-api'])
  })

  it('ranks a run inside a word below every start, and scattered letters below both', () => {
    const projects = [
      project('p-x-a', 999), // scattered
      project('company-site', 900), // inside a word
      project('spare-parts', 800), // inside "spare" comes first, but "parts" starts a word
      project('paste-typer', 1)
    ]
    expect(rankedNames(projects, 'pa')).toEqual([
      'spare-parts',
      'paste-typer',
      'company-site',
      'p-x-a'
    ])
  })

  it('lists the more recently opened first inside each of those kinds too', () => {
    const inside = [project('rapids', 1), project('company-site', 2), project('escape', 3)]
    expect(rankedNames(inside, 'ap')).toEqual(['escape', 'rapids'])
    expect(rankedNames(inside, 'pa')).toEqual(['company-site'])

    // A looser scattered match opened last is above a tighter one opened long ago.
    const scattered = [project('lxexdxg', 1), project('l-o-n-g-e-d-g', 2)]
    expect(rankedNames(scattered, 'ledg')).toEqual(['l-o-n-g-e-d-g', 'lxexdxg'])

    const paths = [
      project('billing', 1, { path: '~/work/payments/billing' }),
      project('invoices', 2, { path: '~/work/payments/invoices' })
    ]
    expect(rankedNames(paths, 'pay')).toEqual(['invoices', 'billing'])
  })

  it('keeps the given (sidebar) order between equally close matches opened at the same time', () => {
    const projects = [project('ledger-b', 5), project('ledger-a', 5)]
    expect(rankedNames(projects, 'ledger')).toEqual(['ledger-b', 'ledger-a'])
  })

  it('matches the path with less weight than any name match', () => {
    const projects = [
      project('billing', 900, { path: '~/work/payments/billing' }),
      project('xpxaxyx', 1) // scattered name match for "pay"
    ]
    const ranked = rankSwitcherProjects(projects, 'pay')
    expect(ranked.map((m) => m.project.name)).toEqual(['xpxaxyx', 'billing'])
    // Only the path matched: the path is highlighted, the name is not.
    expect(ranked[1].nameIndices).toEqual([])
    expect(highlighted('~/work/payments/billing', ranked[1].pathIndices)).toBe('pay')
  })

  it('does not match a path on letters spread far apart', () => {
    const projects = [project('billing', 0, { path: '~/long/enough/directory/geometry' })]
    // l…e…d…g are all there, in order, with far more characters skipped than typed.
    expect(rankSwitcherProjects(projects, 'ledg')).toEqual([])
  })

  it('returns the positions of the matched characters of the name', () => {
    const [prefix] = rankSwitcherProjects([project('ledger-worker')], 'ledg')
    expect(prefix.nameIndices).toEqual([0, 1, 2, 3])
    expect(prefix.pathIndices).toEqual([])

    const [word] = rankSwitcherProjects([project('ledger-worker')], 'WORK')
    expect(highlighted('ledger-worker', word.nameIndices)).toBe('work')
    expect(word.nameIndices).toEqual([7, 8, 9, 10])

    const [scattered] = rankSwitcherProjects([project('ledger-worker')], 'lgw')
    expect(scattered.nameIndices).toEqual([0, 3, 7])
  })

  it('drops projects that match neither name nor path', () => {
    expect(rankedNames([project('ledger'), project('orders')], 'zzz')).toEqual([])
  })

  it('finds every kind of project', () => {
    const projects = [
      project('fixtures-api', 3),
      project('fixtures-stack', 2, { kind: 'connection' }),
      project('fixtures-db', 1, { kind: 'data', path: 'fixtures.sqlite' })
    ]
    expect(rankSwitcherProjects(projects, 'fixt').map((m) => m.project.kind)).toEqual([
      'git',
      'connection',
      'data'
    ])
  })
})

describe('groupSwitcherProjects', () => {
  const projects = [
    project('a', 10),
    project('b', 80),
    project('c', 30),
    project('pinned-1', 99),
    project('d', 70),
    project('e', 20),
    project('pinned-2', 5),
    project('f', 60),
    project('g', 50),
    project('db', 40, { kind: 'data' })
  ]
  const pinnedKeys = [switcherKey('git', 'pinned-2'), switcherKey('git', 'pinned-1')]

  it('lists Pinned in the given order, whatever was opened last', () => {
    expect(names(groupSwitcherProjects(projects, pinnedKeys).pinned)).toEqual([
      'pinned-2',
      'pinned-1'
    ])
  })

  it('lists the five most recently opened unpinned projects under Recent', () => {
    expect(names(groupSwitcherProjects(projects, pinnedKeys).recent)).toEqual([
      'b',
      'd',
      'f',
      'g',
      'db'
    ])
  })

  it('lists everything else under All projects, most recently opened first', () => {
    expect(names(groupSwitcherProjects(projects, pinnedKeys).all)).toEqual(['c', 'e', 'a'])
  })

  it('lists every project exactly once across the three groups', () => {
    const groups = groupSwitcherProjects(projects, pinnedKeys)
    const all = [...groups.pinned, ...groups.recent, ...groups.all].map((p) => p.key)
    expect(all).toHaveLength(projects.length)
    expect(new Set(all).size).toBe(projects.length)
  })

  it('keeps the sidebar order between projects opened at the same time', () => {
    const same = ['x', 'y', 'z'].map((name) => project(name, 7))
    expect(names(groupSwitcherProjects(same, []).recent)).toEqual(['x', 'y', 'z'])
  })

  it('has no Pinned group without pins and ignores a pin of a project that is gone', () => {
    const groups = groupSwitcherProjects(projects.slice(0, 3), [switcherKey('git', 'gone')])
    expect(groups.pinned).toEqual([])
    expect(names(groups.recent)).toEqual(['b', 'c', 'a'])
    expect(groups.all).toEqual([])
  })
})

describe('pinnedSwitcherKeys', () => {
  it('follows the Pinned section: worktrees, then connections, then databases', () => {
    const keys = pinnedSwitcherKeys({
      pinnedWorktreeIds: new Set(['wt-b-main', 'wt-a-feature', 'wt-a-main']),
      pinnedConnectionIds: new Set(['conn-adhoc', 'conn-saved']),
      worktreesByProject: new Map([
        ['proj-a', [{ id: 'wt-a-main' }, { id: 'wt-a-feature' }]],
        ['proj-b', [{ id: 'wt-b-main' }]],
        ['proj-c', [{ id: 'wt-c-main' }]]
      ]),
      connections: [
        { id: 'conn-adhoc', saved_project_id: null },
        { id: 'conn-saved', saved_project_id: 'stack' }
      ],
      dataProjects: [
        { id: 'db-1', pinned: false },
        { id: 'db-2', pinned: true }
      ]
    })
    expect(keys).toEqual([
      switcherKey('git', 'proj-b'),
      // two pinned worktrees, one entry, at the first of them
      switcherKey('git', 'proj-a'),
      // an ad-hoc connection is not a project
      switcherKey('connection', 'stack'),
      switcherKey('data', 'db-2')
    ])
  })

  it('still lists a pinned project whose worktrees are not loaded', () => {
    const keys = pinnedSwitcherKeys({
      pinnedWorktreeIds: new Set(['wt-unknown']),
      pinnedConnectionIds: new Set(),
      pinnedProjectIds: new Set(['proj-x']),
      worktreesByProject: new Map(),
      connections: [],
      dataProjects: []
    })
    expect(keys).toEqual([switcherKey('git', 'proj-x')])
  })
})

describe('switcherAgentState', () => {
  it('shows nothing for a project with no live agent', () => {
    expect(switcherAgentState([])).toBeNull()
    expect(switcherAgentState([null, 'completed', 'unread'])).toBeNull()
  })

  it('shows working while a worktree is working or planning', () => {
    expect(switcherAgentState([null, 'working'])).toBe('working')
    expect(switcherAgentState(['planning'])).toBe('working')
  })

  it('shows waiting-on-the-user ahead of working', () => {
    for (const status of ['answering', 'permission', 'command_approval', 'plan_ready']) {
      expect(switcherAgentState(['working', status])).toBe('question')
    }
  })
})

describe('row text helpers', () => {
  it('shortens the home folder of a path', () => {
    expect(shortenHomePath('/Users/ana/code/api')).toBe('~/code/api')
    expect(shortenHomePath('/home/ana/code/api')).toBe('~/code/api')
    expect(shortenHomePath('/Users/ana')).toBe('~')
    expect(shortenHomePath('C:\\Users\\ana\\code\\api')).toBe('~\\code\\api')
    expect(shortenHomePath('/opt/Users/ana/api')).toBe('/opt/Users/ana/api')
    expect(shortenHomePath('localhost / shop')).toBe('localhost / shop')
  })

  it('reads a stored last-opened time', () => {
    expect(parseOpenedAt('2026-01-05T15:08:00.000Z')).toBe(Date.UTC(2026, 0, 5, 15, 8))
    expect(parseOpenedAt(null)).toBe(0)
    expect(parseOpenedAt('not a date')).toBe(0)
  })

  it('says how long ago a project was opened', () => {
    const now = Date.UTC(2026, 5, 15, 12)
    const ago = (ms: number): string => formatOpenedAge(now - ms, now)
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    expect(ago(20_000)).toBe('now')
    expect(ago(5 * minute)).toBe('5m')
    expect(ago(2 * hour)).toBe('2h')
    expect(ago(3 * day)).toBe('3d')
    expect(ago(65 * day)).toBe('2mo')
    expect(ago(800 * day)).toBe('2yr')
    // never opened, or a clock that moved back
    expect(formatOpenedAge(0, now)).toBe('')
    expect(formatOpenedAge(now + hour, now)).toBe('now')
  })
})
