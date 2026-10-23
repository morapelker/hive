// A data project's icon, everywhere it appears (sidebar row, pinned card, header, toolbar,
// wizard preview). Resolution: the user's choice (another engine's tile, an emoji, a curated
// lucide glyph, an uploaded image through the project-icons pipeline), else the project's own
// engine tile. `iconColor` tints the tile (engine/lucide) and staging/production add a small
// environment dot so a production database is recognisable even in a dense sidebar. When the
// main icon is not the engine logo, a tiny engine badge stays in the corner (an emoji must never
// hide that the connection is PostgreSQL).

import { useEffect, useState } from 'react'
import {
  Activity,
  Archive,
  BarChart3,
  Boxes,
  Briefcase,
  Building2,
  Cloud,
  Coins,
  Cpu,
  Cylinder,
  Database,
  DatabaseZap,
  FlaskConical,
  Globe,
  HardDrive,
  Layers,
  LineChart,
  Package,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Table2,
  Users,
  Warehouse,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { projectApi } from '@/api/project-api'
import { cn } from '@/lib/utils'
import type {
  DataEngine,
  DataEnvironment,
  DataProjectIcon as DataProjectIconSpec
} from '@shared/data-projects/types'
import { EngineGlyph, EngineTile } from './engine-logos'
import { environmentColor, isFlaggedEnvironment } from './data-project-ui'

/** Curated lucide glyphs offered by the icon picker (stored by name). */
export const DATA_PROJECT_LUCIDE_ICONS: Readonly<Record<string, LucideIcon>> = {
  Database,
  DatabaseZap,
  Cylinder,
  Server,
  HardDrive,
  Table2,
  Layers,
  Boxes,
  Package,
  Archive,
  Warehouse,
  Cloud,
  Globe,
  Cpu,
  Activity,
  BarChart3,
  LineChart,
  Coins,
  ShoppingCart,
  Users,
  Briefcase,
  Building2,
  Shield,
  FlaskConical,
  Rocket,
  Zap
}

export const resolveLucideIcon = (name: string): LucideIcon =>
  DATA_PROJECT_LUCIDE_ICONS[name] ?? Database

// ---------------------------------------------------------------------------------------------
// Uploaded image icons (~/.hive/project-icons/<file>) → data URL, cached per file name
// ---------------------------------------------------------------------------------------------

const imageCache = new Map<string, string>()
const imageListeners = new Map<string, Set<() => void>>()

/**
 * Drops a cached image so the next render re-reads it. Needed after "Upload image…" on an
 * existing project: the file name (`<id>.<ext>`) stays the same while the content changes.
 */
export function invalidateDataProjectIconImage(fileName: string): void {
  imageCache.delete(fileName)
  for (const listener of imageListeners.get(fileName) ?? []) listener()
}

export function useDataProjectIconImage(fileName: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(
    fileName ? (imageCache.get(fileName) ?? null) : null
  )
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!fileName) return
    const listeners = imageListeners.get(fileName) ?? new Set<() => void>()
    const listener = (): void => setGeneration((g) => g + 1)
    listeners.add(listener)
    imageListeners.set(fileName, listeners)
    return () => {
      listeners.delete(listener)
    }
  }, [fileName])

  useEffect(() => {
    if (!fileName) {
      setUrl(null)
      return
    }
    const cached = imageCache.get(fileName)
    if (cached) {
      setUrl(cached)
      return
    }
    let cancelled = false
    projectApi
      .getProjectIconPath(fileName)
      .then((dataUrl) => {
        if (cancelled) return
        if (dataUrl) imageCache.set(fileName, dataUrl)
        setUrl(dataUrl ?? null)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [fileName, generation])

  return url
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

export interface DataProjectIconProps {
  engine: DataEngine
  icon: DataProjectIconSpec | null
  iconColor?: string | null
  /** Draws the environment dot for staging/production. */
  environment?: DataEnvironment
  /** Environment colour override (project.color). */
  environmentColorOverride?: string | null
  /** Outer size, default 16px (the sidebar icon box). */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  /** Hide the engine corner badge (the wizard preview shows the engine next to it anyway). */
  hideEngineBadge?: boolean
}

const SIZE_CLASS: Record<NonNullable<DataProjectIconProps['size']>, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-7',
  xl: 'size-10'
}

const EMOJI_CLASS: Record<NonNullable<DataProjectIconProps['size']>, string> = {
  sm: 'text-[13px]',
  md: 'text-[15px]',
  lg: 'text-[20px]',
  xl: 'text-[28px]'
}

const DOT_CLASS: Record<NonNullable<DataProjectIconProps['size']>, string> = {
  sm: 'size-[6px] -right-[2px] -bottom-[2px]',
  md: 'size-[7px] -right-[2px] -bottom-[2px]',
  lg: 'size-[9px] -right-[3px] -bottom-[3px]',
  xl: 'size-3 -right-1 -bottom-1'
}

export function DataProjectIcon({
  engine,
  icon,
  iconColor,
  environment,
  environmentColorOverride,
  size = 'sm',
  className,
  hideEngineBadge
}: DataProjectIconProps): React.JSX.Element {
  const imageUrl = useDataProjectIconImage(icon?.kind === 'image' ? icon.fileName : null)
  const sizeClass = SIZE_CLASS[size]

  let body: React.JSX.Element
  let showsOwnEngine = false
  if (!icon || icon.kind === 'engine') {
    const shown = icon?.kind === 'engine' ? icon.engine : engine
    showsOwnEngine = shown === engine
    body = (
      <EngineTile
        engine={shown}
        tint={iconColor}
        className={cn(
          sizeClass,
          size === 'xl' && 'rounded-[8px]',
          size === 'lg' && 'rounded-[6px]'
        )}
      />
    )
  } else if (icon.kind === 'emoji') {
    body = (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center leading-none',
          sizeClass,
          EMOJI_CLASS[size]
        )}
        aria-hidden="true"
      >
        {icon.emoji}
      </span>
    )
  } else if (icon.kind === 'lucide') {
    const Glyph = resolveLucideIcon(icon.name)
    body = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', sizeClass)}
        style={iconColor ? { color: iconColor } : undefined}
      >
        <Glyph className="size-[88%]" strokeWidth={2.25} />
      </span>
    )
  } else if (imageUrl) {
    body = (
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        className={cn('shrink-0 rounded-[4px] object-cover', sizeClass)}
      />
    )
  } else {
    // Image not resolved (yet, or the file is gone): the engine tile keeps the row readable.
    showsOwnEngine = true
    body = <EngineTile engine={engine} tint={iconColor} className={sizeClass} />
  }

  const flagged = environment ? isFlaggedEnvironment(environment) : false
  const dotColor =
    environment && flagged
      ? environmentColor({ environment, color: environmentColorOverride ?? null })
      : null
  const showBadge = !hideEngineBadge && !showsOwnEngine && size !== 'sm'

  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      data-testid="data-project-icon"
      data-icon-kind={icon?.kind ?? 'engine'}
    >
      {body}
      {showBadge && (
        <span className="absolute -left-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-[3px] bg-background ring-1 ring-border">
          <EngineGlyph engine={engine} className="size-2.5 text-foreground" />
        </span>
      )}
      {dotColor && (
        <span
          className={cn('absolute rounded-full ring-2 ring-worktree-sidebar', DOT_CLASS[size])}
          style={{ backgroundColor: dotColor }}
          data-testid="data-project-environment-dot"
          aria-label={environment}
        />
      )}
    </span>
  )
}
