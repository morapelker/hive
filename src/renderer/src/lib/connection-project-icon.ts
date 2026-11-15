/**
 * The default icon of a connection project (projects.kind === 'connection'): a small set of
 * its member projects' icons. Pure selection logic — which members' icons are shown, in what
 * order — with no store or component imports; rendering lives in
 * components/projects/ConnectionProjectIcon.tsx.
 *
 * Nothing is persisted: the icon is derived from the member rows every time it renders, so it
 * follows member edits and member icon changes on its own.
 */

/** Tiles in the square icon (sidebar, pickers): an overlapping pair. */
export const CONNECTION_ICON_BOX_TILES = 2
/** Tiles in the inline strip (ticket project tag). */
export const CONNECTION_ICON_STRIP_TILES = 3

/** The fields of a member project row that decide what its icon looks like. */
export interface IconMember {
  id: string
  name: string
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
}

interface ProjectRowLike {
  id: string
  name: string
  kind?: 'git' | 'connection'
  language?: string | null
  custom_icon?: string | null
  detected_icon?: string | null
}

/**
 * How well an icon identifies its project: 2 = the project's own image (custom icon or
 * favicon), 1 = a language logo it shares with every project in that language, 0 = no icon.
 */
export type IconTier = 0 | 1 | 2

export interface IconIdentity {
  /** Members with the same key display the same icon. */
  key: string
  tier: IconTier
}

export type IconTile =
  | { kind: 'icon'; key: string; member: IconMember }
  /** A neutral plate standing in for members that have no icon of their own. */
  | { kind: 'generic'; key: 'generic' }

const GENERIC_KEY = 'generic'

/**
 * The icon a member row displays, read from the row alone (synchronous, so the layout never
 * reshuffles while image files load). Mirrors the LanguageIcon priority chain.
 */
export function iconIdentity(
  member: Pick<IconMember, 'language' | 'custom_icon' | 'detected_icon'>,
  isKnownLanguage: (language: string) => boolean
): IconIdentity {
  if (member.custom_icon) return { key: `custom:${member.custom_icon}`, tier: 2 }
  if (member.detected_icon && member.detected_icon !== 'none') {
    return { key: `detected:${member.detected_icon}`, tier: 2 }
  }
  if (member.language && isKnownLanguage(member.language)) {
    return { key: `lang:${member.language}`, tier: 1 }
  }
  return { key: GENERIC_KEY, tier: 0 }
}

/**
 * Resolve stored member ids against the project rows, in stored order. Ids whose project is
 * gone are dropped silently (as everywhere else members are resolved), as are repeated ids,
 * the connection project itself and other connection projects.
 */
export function resolveIconMembers(
  memberIds: readonly string[],
  projects: readonly ProjectRowLike[],
  selfId?: string | null
): IconMember[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const members: IconMember[] = []
  for (const id of memberIds) {
    if (id === selfId || seen.has(id)) continue
    seen.add(id)
    const project = byId.get(id)
    if (!project || project.kind === 'connection') continue
    members.push({
      id: project.id,
      name: project.name,
      language: project.language ?? null,
      custom_icon: project.custom_icon ?? null,
      detected_icon: project.detected_icon ?? null
    })
  }
  return members
}

/**
 * Members as one primitive string — equal for equal member values — so a store selector can
 * return it without re-rendering subscribers whenever an unrelated row changes.
 */
export function iconMembersSignature(members: readonly IconMember[]): string {
  return JSON.stringify(
    members.map((m) => [m.id, m.name, m.language, m.custom_icon, m.detected_icon])
  )
}

export function parseIconMembersSignature(signature: string): IconMember[] {
  const rows = JSON.parse(signature) as [
    string,
    string,
    string | null,
    string | null,
    string | null
  ][]
  return rows.map(([id, name, language, custom_icon, detected_icon]) => ({
    id,
    name,
    language,
    custom_icon,
    detected_icon
  }))
}

interface IconGroup {
  key: string
  tier: IconTier
  /** Position of the group's first member in member order. */
  index: number
  members: IconMember[]
}

/**
 * Pick the tiles of a connection project's default icon, at most `slots` of them.
 *
 * - Members showing the same icon share one tile (unique icons are preferred).
 * - No member has an icon → no tiles; the caller shows its fallback.
 * - Two or more unique icons → when they do not all fit, a project's own image wins over a
 *   language logo, then earlier members win; the chosen tiles are shown in member order.
 *   Members without an icon take no tile.
 * - One unique icon → always a pair, so a connection never looks like a plain project: the
 *   icon twice when every member shows it, else the icon plus a neutral plate (some member
 *   has no icon, or only one member is left).
 */
export function pickConnectionIconTiles(
  members: readonly IconMember[],
  isKnownLanguage: (language: string) => boolean,
  slots: number = CONNECTION_ICON_BOX_TILES
): IconTile[] {
  const groups = new Map<string, IconGroup>()
  members.forEach((member, index) => {
    const { key, tier } = iconIdentity(member, isKnownLanguage)
    const group = groups.get(key)
    if (group) group.members.push(member)
    else groups.set(key, { key, tier, index, members: [member] })
  })

  const distinctive = [...groups.values()].filter((group) => group.tier > 0)
  if (distinctive.length === 0) return []

  const iconTile = (group: IconGroup, member: IconMember = group.members[0]): IconTile => ({
    kind: 'icon',
    key: group.key,
    member
  })
  const plate: IconTile = { kind: 'generic', key: GENERIC_KEY }

  if (distinctive.length === 1) {
    const [only] = distinctive
    const second =
      !groups.has(GENERIC_KEY) && only.members.length >= 2 ? iconTile(only, only.members[1]) : plate
    return [iconTile(only), second]
  }

  const max = Math.max(2, Math.floor(slots) || 0)
  return [...distinctive]
    .sort((a, b) => b.tier - a.tier || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((group) => iconTile(group))
}
