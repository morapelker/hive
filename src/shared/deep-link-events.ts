/**
 * Links that drive Hive from outside (launchers like Raycast):
 * - `hive://worktree/<id>` and `hive://connection/<id>` open Hive on that worktree or
 *   connection.
 * - `hive://connection/new?projects=<id>[:base],<id>...[&pull=0|1]` opens the "Go to project"
 *   switcher with those projects picked, in that order, as Shift+Enter there would (or
 *   Cmd+Shift+Enter for an `:base` one, which joins on its base branch). `pull` sets the
 *   switcher's "Pull latest from origin" switch; without it the switch stays as is. Nothing is
 *   created until the user presses Enter in the switcher: a link can come from anywhere.
 *
 * The main process resolves the link and publishes DEEP_LINK_NAVIGATE_CHANNEL; the renderer
 * acts on it.
 */
export const DEEP_LINK_NAVIGATE_CHANNEL = 'deep-link:navigate'

export interface DeepLinkConnectionMember {
  readonly projectId: string
  /** Joins on its base branch, with no new worktree (Cmd+Shift+Enter in the switcher). */
  readonly useBase: boolean
}

export type DeepLinkNavigatePayload =
  | { readonly kind: 'worktree'; readonly projectId: string; readonly worktreeId: string }
  | { readonly kind: 'connection'; readonly connectionId: string }
  | {
      readonly kind: 'new-connection'
      /** One per link: a link re-published at startup must pick the projects only once. */
      readonly requestId: string
      readonly members: readonly DeepLinkConnectionMember[]
      readonly pull?: boolean
    }

export type NavigateDeepLink =
  | { readonly kind: 'worktree' | 'connection'; readonly id: string }
  | {
      readonly kind: 'new-connection'
      readonly members: readonly DeepLinkConnectionMember[]
      readonly pull?: boolean
    }

function parseNewConnection(parsed: URL): NavigateDeepLink | null {
  const seen = new Set<string>()
  const members: DeepLinkConnectionMember[] = []
  for (const entry of (parsed.searchParams.get('projects') ?? '').split(',')) {
    const [projectId, mode, ...rest] = entry.trim().split(':')
    if (!projectId || rest.length > 0 || (mode !== undefined && mode !== 'base')) return null
    if (seen.has(projectId)) continue
    seen.add(projectId)
    members.push({ projectId, useBase: mode === 'base' })
  }
  if (members.length === 0) return null

  const pullParam = parsed.searchParams.get('pull')
  if (pullParam !== null && pullParam !== '0' && pullParam !== '1') return null
  return pullParam === null
    ? { kind: 'new-connection', members }
    : { kind: 'new-connection', members, pull: pullParam === '1' }
}

/** Parse a navigation link; returns null for anything that is not one. */
export function parseNavigateDeepLink(url: string): NavigateDeepLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'hive:') return null

  const kind = parsed.hostname
  if (kind !== 'worktree' && kind !== 'connection') return null

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  const id = decodeURIComponent(segments[0])
  if (kind === 'connection' && id === 'new') return parseNewConnection(parsed)
  return id ? { kind, id } : null
}
