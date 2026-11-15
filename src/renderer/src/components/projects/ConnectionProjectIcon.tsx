/**
 * The default icon of a connection project: its member projects' icons.
 *
 * - `ProjectIcon` — drop-in for a project row of either kind (git → LanguageIcon).
 * - `ConnectionProjectIcon` — the composite itself: a 16px square holding an overlapping pair
 *   (sidebar, pickers), or an inline strip of full-size tiles (ticket project tag).
 * - `ConnectionMembersTooltip` — hover legend naming every member next to its icon.
 *
 * Which members' icons are shown is decided in lib/connection-project-icon.ts.
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { FolderGit2, Link } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useConnectionIconMembers,
  useConnectionProjectIconTiles
} from '@/hooks/useConnectionProjectIcon'
import {
  CONNECTION_ICON_BOX_TILES,
  CONNECTION_ICON_STRIP_TILES,
  type IconMember,
  type IconTile
} from '@/lib/connection-project-icon'
import { LanguageIcon, useProjectIconUrl, useResolvedProjectIcon } from './LanguageIcon'

// ── Geometry ───────────────────────────────────────────────────────
// Box: two 9px tiles on the diagonal of a 16px square, overlapping by 2px so most of the back
// icon stays visible. The back tile has its covered corner cut away, 1px wider than the
// overlap, so the gap between the tiles is truly transparent — correct on hovered and
// selected rows alike, with no ring color to keep in sync.
const BOX_TILE_PX = 9
const BOX_OFFSET_PX = 16 - BOX_TILE_PX
const BOX_NOTCH_PX = BOX_TILE_PX - BOX_OFFSET_PX + 1
const BOX_NOTCH = `polygon(${BOX_NOTCH_PX}px 0, 100% 0, 100% 100%, 0 100%, 0 ${BOX_NOTCH_PX}px, ${BOX_NOTCH_PX}px ${BOX_NOTCH_PX}px)`
const STRIP_TILE_PX = 12
const TOOLTIP_TILE_PX = 14
const MAX_TOOLTIP_ROWS = 8

const tileStyle = (size: number, style?: CSSProperties): CSSProperties => ({
  width: size,
  height: size,
  // Literal radii: `rounded-sm` is 6px in this theme, too round for tiles this small.
  borderRadius: size < 14 ? 3 : 4,
  ...style
})

interface TileProps {
  /** Edge length in px. */
  size: number
  /** On an inverted surface (the tooltip, which is bg-foreground). */
  inverted?: boolean
  style?: CSSProperties
}

/** Neutral plate for members without an icon of their own. */
function GenericTile({ size, inverted, style }: TileProps): React.JSX.Element {
  return (
    <span
      data-tile="generic"
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden',
        inverted ? 'bg-background/20 text-background/80' : 'bg-foreground/10 text-muted-foreground'
      )}
      style={tileStyle(size, style)}
    >
      <FolderGit2 className="size-[70%]" />
    </span>
  )
}

/** One member project's icon, resolved exactly as LanguageIcon would resolve it. */
function MemberIconTile({
  member,
  size,
  inverted,
  style
}: TileProps & { member: IconMember }): React.JSX.Element {
  const icon = useResolvedProjectIcon(member.language, member.custom_icon, member.detected_icon)

  if (icon.kind === 'generic') return <GenericTile size={size} inverted={inverted} style={style} />

  if (icon.kind === 'badge') {
    // The two-letter label needs a 12px tile; below that only the first letter fits.
    return (
      <span
        data-tile="badge"
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden font-bold leading-none',
          size < 14 ? 'text-[7px]' : 'text-[8px]',
          icon.config.bg,
          icon.config.text
        )}
        style={tileStyle(size, style)}
      >
        {size < 12 ? icon.config.label.charAt(0) : icon.config.label}
      </span>
    )
  }

  return (
    <span
      data-tile="image"
      className="block shrink-0 overflow-hidden"
      style={tileStyle(size, style)}
    >
      <img src={icon.src} alt="" draggable={false} className="block size-full object-contain" />
    </span>
  )
}

function Tile({ tile, ...props }: TileProps & { tile: IconTile }): React.JSX.Element {
  return tile.kind === 'icon' ? (
    <MemberIconTile member={tile.member} {...props} />
  ) : (
    <GenericTile {...props} />
  )
}

interface ConnectionProjectIconProps {
  /** Id of the connection project (anything else renders the fallback). */
  projectId: string
  /** 'box' = 16px square with an overlapping pair; 'strip' = inline row of 12px tiles. */
  layout?: 'box' | 'strip'
  /** Rendered when no member has an icon to show. */
  fallback?: ReactNode
  className?: string
  'data-testid'?: string
}

export function ConnectionProjectIcon({
  projectId,
  layout = 'box',
  fallback = null,
  className,
  'data-testid': testId = 'connection-project-icon'
}: ConnectionProjectIconProps): React.JSX.Element {
  const isStrip = layout === 'strip'
  const tiles = useConnectionProjectIconTiles(
    projectId,
    isStrip ? CONNECTION_ICON_STRIP_TILES : CONNECTION_ICON_BOX_TILES
  )

  if (tiles.length === 0) return <>{fallback}</>

  // A padded pair repeats a tile key, so the position is part of the React key.
  const tileKey = (tile: IconTile, index: number): string => `${tile.key}#${index}`

  if (isStrip) {
    return (
      <span
        aria-hidden="true"
        data-testid={testId}
        data-layout="strip"
        className={cn('inline-flex shrink-0 items-center gap-px', className)}
      >
        {tiles.map((tile, index) => (
          <Tile key={tileKey(tile, index)} tile={tile} size={STRIP_TILE_PX} />
        ))}
      </span>
    )
  }

  const [front, back] = tiles
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-layout="box"
      className={cn('relative inline-block size-4 shrink-0', className)}
    >
      <Tile
        key={tileKey(back, 1)}
        tile={back}
        size={BOX_TILE_PX}
        style={{
          position: 'absolute',
          left: BOX_OFFSET_PX,
          top: BOX_OFFSET_PX,
          clipPath: BOX_NOTCH
        }}
      />
      <Tile
        key={tileKey(front, 0)}
        tile={front}
        size={BOX_TILE_PX}
        style={{ position: 'absolute', left: 0, top: 0 }}
      />
    </span>
  )
}

interface ConnectionMembersTooltipProps {
  /** Id of the connection project. */
  projectId: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** The hover target; rendered bare when the project has no resolvable members. */
  children: ReactElement
}

/**
 * Hover legend for a connection project's icon: every member project by name, next to its
 * own icon. The composite shows a few small tiles; this is where all of them get a name.
 */
export function ConnectionMembersTooltip({
  projectId,
  side = 'top',
  align = 'center',
  children
}: ConnectionMembersTooltipProps): React.JSX.Element {
  const members = useConnectionIconMembers(projectId)
  if (members.length === 0) return children

  const shown = members.slice(0, MAX_TOOLTIP_ROWS)
  const hidden = members.length - shown.length

  return (
    // Its own provider, at the app's delay: the targets are also rendered without the app's
    // root around them (their tests).
    <TooltipProvider delayDuration={350}>
      {/* Read-only legend: it never takes the pointer, so a click on it cannot bubble (through
          the React portal) into the sidebar row or ticket card the target sits in. */}
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          className="pointer-events-none max-w-xs"
          data-testid="connection-members-tooltip"
        >
          <div className="flex flex-col gap-1 py-0.5 text-left">
            <span className="text-background/70">
              Connects {members.length} {members.length === 1 ? 'project' : 'projects'}
            </span>
            {shown.map((member) => (
              <span key={member.id} className="flex min-w-0 items-center gap-1.5">
                <MemberIconTile member={member} size={TOOLTIP_TILE_PX} inverted />
                <span className="min-w-0 truncate">{member.name}</span>
              </span>
            ))}
            {hidden > 0 && <span className="text-background/70">and {hidden} more</span>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface ProjectIconProject {
  id: string
  kind?: 'git' | 'connection'
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
}

/** A connection project with no member icon to show keeps the link glyph. */
const CONNECTION_FALLBACK = (
  <span className="inline-flex size-4 shrink-0 items-center justify-center">
    <Link className="size-3.5 text-muted-foreground" />
  </span>
)

function ConnectionProjectDefaultIcon({
  project
}: {
  project: ProjectIconProject
}): React.JSX.Element {
  // A custom icon set on the connection project itself wins over the member composite.
  const customIconUrl = useProjectIconUrl(project.custom_icon)
  if (project.custom_icon && typeof customIconUrl === 'string' && customIconUrl) {
    return (
      <img
        src={customIconUrl}
        alt="project icon"
        title="Custom project icon"
        className="h-4 w-4 shrink-0 object-contain rounded-sm"
      />
    )
  }
  return <ConnectionProjectIcon projectId={project.id} fallback={CONNECTION_FALLBACK} />
}

/**
 * The 16px icon of any project row: a git project's own icon (custom icon, favicon or
 * language logo), or a connection project's default icon built from its members.
 */
export function ProjectIcon({ project }: { project: ProjectIconProject }): React.JSX.Element {
  if (project.kind === 'connection') return <ConnectionProjectDefaultIcon project={project} />
  return (
    <LanguageIcon
      language={project.language}
      customIcon={project.custom_icon}
      detectedIcon={project.detected_icon}
    />
  )
}
