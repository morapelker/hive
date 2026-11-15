import { describe, expect, it, vi } from 'vitest'
import {
  CONNECTION_ICON_BOX_TILES,
  CONNECTION_ICON_STRIP_TILES,
  iconIdentity,
  iconMembersSignature,
  parseIconMembersSignature,
  pickConnectionIconTiles,
  resolveIconMembers,
  type IconMember
} from './connection-project-icon'

// Stand-in for LANGUAGE_MAP with production's own-key rule, so 'constructor' is not a language.
const KNOWN_LANGUAGES: Record<string, true> = {
  typescript: true,
  go: true,
  rust: true,
  python: true
}
const isKnown = (language: string): boolean =>
  Object.prototype.hasOwnProperty.call(KNOWN_LANGUAGES, language)

const member = (id: string, overrides: Partial<IconMember> = {}): IconMember => ({
  id,
  name: `project-${id}`,
  language: null,
  custom_icon: null,
  detected_icon: null,
  ...overrides
})
const ts = (id: string): IconMember => member(id, { language: 'typescript' })
const go = (id: string): IconMember => member(id, { language: 'go' })
const rust = (id: string): IconMember => member(id, { language: 'rust' })
const python = (id: string): IconMember => member(id, { language: 'python' })
const custom = (id: string): IconMember => member(id, { custom_icon: `${id}.png` })
const favicon = (id: string): IconMember => member(id, { detected_icon: `/${id}/icon.svg` })
const bare = (id: string): IconMember => member(id)

// '<key>@<member id>' per icon tile, 'plate' for the neutral plate.
const pick = (members: readonly IconMember[], slots?: number): string[] =>
  pickConnectionIconTiles(members, isKnown, slots).map((tile) =>
    tile.kind === 'icon' ? `${tile.key}@${tile.member.id}` : 'plate'
  )

describe('tile counts', () => {
  it('the box holds 2 tiles and the strip 3', () => {
    expect(CONNECTION_ICON_BOX_TILES).toBe(2)
    expect(CONNECTION_ICON_STRIP_TILES).toBe(3)
  })
})

describe('iconIdentity', () => {
  it.each<[Partial<IconMember>, string, number]>([
    [{ custom_icon: 'a.png', detected_icon: '/a/icon.svg', language: 'go' }, 'custom:a.png', 2],
    [{ detected_icon: '/a/icon.svg', language: 'go' }, 'detected:/a/icon.svg', 2],
    [{ detected_icon: 'none', language: 'go' }, 'lang:go', 1],
    [{ detected_icon: '', language: 'go' }, 'lang:go', 1],
    [{ detected_icon: null, language: 'go' }, 'lang:go', 1],
    [{ language: 'cobol' }, 'generic', 0],
    [{ language: 'constructor' }, 'generic', 0],
    [{}, 'generic', 0]
  ])('%j → %s (tier %i)', (fields, key, tier) => {
    expect(iconIdentity(member('a', fields), isKnown)).toEqual({ key, tier })
  })

  it('asks the predicate about the row language and obeys the answer', () => {
    const accept = vi.fn<(language: string) => boolean>(() => true)
    expect(iconIdentity(member('a', { language: 'cobol' }), accept)).toEqual({
      key: 'lang:cobol',
      tier: 1
    })
    expect(accept).toHaveBeenCalledWith('cobol')
    expect(iconIdentity(go('a'), () => false)).toEqual({ key: 'generic', tier: 0 })
  })
})

describe('resolveIconMembers', () => {
  const projects = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', kind: 'git' as const },
    { id: 'c', name: 'C' },
    { id: 'conn', name: 'Conn', kind: 'connection' as const }
  ]

  it.each<[string, string[], string | undefined, string[]]>([
    ['keeps stored order, not project-list order', ['c', 'a', 'b'], undefined, ['c', 'a', 'b']],
    ['drops unknown ids', ['gone', 'a', 'missing', 'b'], undefined, ['a', 'b']],
    ['drops repeated ids', ['b', 'a', 'b', 'a'], undefined, ['b', 'a']],
    ["drops the project's own id", ['a', 'b'], 'a', ['b']],
    ['drops connection-kind rows', ['conn', 'a'], undefined, ['a']]
  ])('%s', (_rule, stored, selfId, expected) => {
    expect(resolveIconMembers(stored, projects, selfId).map((m) => m.id)).toEqual(expected)
  })

  it('reduces a row to its icon fields, unset ones as null', () => {
    const rows = [
      {
        id: 'a',
        name: 'web',
        path: '/a',
        language: 'go',
        custom_icon: 'a.png',
        detected_icon: 'none'
      },
      { id: 'b', name: 'api', path: '/b' }
    ]
    expect(resolveIconMembers(['a', 'b'], rows)).toStrictEqual([
      { id: 'a', name: 'web', language: 'go', custom_icon: 'a.png', detected_icon: 'none' },
      { id: 'b', name: 'api', language: null, custom_icon: null, detected_icon: null }
    ])
  })
})

describe('iconMembersSignature', () => {
  const web = member('a', { name: 'web', language: 'typescript', custom_icon: 'web.png' })
  const api = member('b', { name: 'api', language: 'go', detected_icon: '/b/icon.svg' })
  const signature = iconMembersSignature([web, api])

  it('is equal for equal member values', () => {
    expect(iconMembersSignature([{ ...web }, { ...api }])).toBe(signature)
  })

  it.each<[string, IconMember[]]>([
    ['an id', [{ ...web, id: 'a2' }, api]],
    ['a name', [{ ...web, name: 'site' }, api]],
    ['a language', [{ ...web, language: null }, api]],
    ['a custom icon', [{ ...web, custom_icon: 'other.png' }, api]],
    ['a favicon', [web, { ...api, detected_icon: 'none' }]],
    ['the member order', [api, web]],
    ['a member leaving', [web]],
    ['a member joining', [web, api, member('c')]]
  ])('changes with %s', (_what, members) => {
    expect(iconMembersSignature(members)).not.toBe(signature)
  })

  it('round-trips through parseIconMembersSignature, awkward text included', () => {
    const members = [
      member('a,"1"', { name: 'say "hi", café 日本語 \u{1F680}', custom_icon: 'x, y.png' }),
      member('b', { language: 'go', detected_icon: '/b/["quoted"],/icon.svg' }),
      member('c')
    ]
    expect(parseIconMembersSignature(iconMembersSignature(members))).toStrictEqual(members)
  })
})

describe('pickConnectionIconTiles', () => {
  const threeLogos = [ts('a'), go('b'), rust('c')]

  it('one resolved member → its icon tile, then the neutral plate', () => {
    const only = custom('a')
    expect(pickConnectionIconTiles([only], isKnown, 3)).toEqual([
      { kind: 'icon', key: 'custom:a.png', member: only },
      { kind: 'generic', key: 'generic' }
    ])
  })

  // Up to two unique icons the answer is the same for the box (2 slots) and the strip (3).
  it.each<[string, IconMember[], string[]]>([
    ['no members → no tiles', [], []],
    [
      'no member with an icon → no tiles',
      [bare('a'), member('b', { language: 'cobol' }), member('c', { detected_icon: 'none' })],
      []
    ],
    [
      'two unique icons → both, in member order',
      [go('a'), custom('b')],
      ['lang:go@a', 'custom:b.png@b']
    ],
    [
      'ts, ts, go → members with the same icon share a tile',
      [ts('a'), ts('b'), go('c')],
      ['lang:typescript@a', 'lang:go@c']
    ],
    [
      'one icon shown by every member → the icon twice, from the first two members',
      [ts('a'), ts('b'), ts('c')],
      ['lang:typescript@a', 'lang:typescript@b']
    ],
    [
      'one icon and a generic member listed first → the icon first, then the plate',
      [bare('g'), ts('a'), ts('b')],
      ['lang:typescript@a', 'plate']
    ],
    [
      'generic members take no tile once two unique icons exist',
      [bare('g'), ts('a'), bare('h'), go('b')],
      ['lang:typescript@a', 'lang:go@b']
    ]
  ])('%s', (_rule, members, expected) => {
    expect(pick(members, 2)).toEqual(expected)
    expect(pick(members, 3)).toEqual(expected)
  })

  it.each<[string, IconMember[], string[], string[]]>([
    [
      'logos only: earlier members win',
      [ts('a'), go('b'), rust('c'), python('d')],
      ['lang:typescript@a', 'lang:go@b'],
      ['lang:typescript@a', 'lang:go@b', 'lang:rust@c']
    ],
    [
      'own images beat earlier logos, a favicon ranking with a custom icon',
      [ts('a'), go('b'), favicon('c'), custom('d'), custom('e'), custom('f')],
      ['detected:/c/icon.svg@c', 'custom:d.png@d'],
      ['detected:/c/icon.svg@c', 'custom:d.png@d', 'custom:e.png@e']
    ],
    [
      'a late own image takes a slot but stays in member order',
      [ts('a'), go('b'), rust('c'), custom('d')],
      ['lang:typescript@a', 'custom:d.png@d'],
      ['lang:typescript@a', 'lang:go@b', 'custom:d.png@d']
    ]
  ])('more unique icons than slots, %s', (_rule, members, box, strip) => {
    expect(pick(members, 2)).toEqual(box)
    expect(pick(members, 3)).toEqual(strip)
  })

  it("uses the box's slot count when none is given", () => {
    expect(pick(threeLogos)).toEqual(['lang:typescript@a', 'lang:go@b'])
  })

  it.each([1, 0, -3, 1.5, 2.9, Number.NaN])(
    'a slot count of %s gives the minimum pair',
    (slots) => {
      expect(pick(threeLogos, slots)).toEqual(['lang:typescript@a', 'lang:go@b'])
    }
  )

  it('does not mutate its input', () => {
    const build = (): IconMember[] => [rust('a'), bare('g'), custom('b'), go('c'), rust('d')]
    const members = Object.freeze(build().map((m) => Object.freeze(m)))
    pick(members, 2)
    expect(members).toEqual(build())
  })
})
