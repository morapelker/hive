import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { projectApi } from '@/api/project-api'

// Bundled language icons (Vite resolves these to hashed asset URLs at build time)
import typescriptIcon from '@/assets/language-icons/typescript.svg'
import javascriptIcon from '@/assets/language-icons/javascript.svg'
import pythonIcon from '@/assets/language-icons/python.svg'
import goIcon from '@/assets/language-icons/go.png'
import rustIcon from '@/assets/language-icons/rust.svg'
import swiftIcon from '@/assets/language-icons/swift.svg'
import javaIcon from '@/assets/language-icons/java.svg'
import kotlinIcon from '@/assets/language-icons/kotlin.svg'
import cIcon from '@/assets/language-icons/c.svg'
import cppIcon from '@/assets/language-icons/c-plusplus.svg'
import csharpIcon from '@/assets/language-icons/csharp.svg'

interface LanguageIconProps {
  language: string | null
  customIcon?: string | null
  detectedIcon?: string | null
  className?: string
}

export interface LanguageConfig {
  label: string
  bg: string
  text: string
}

/** Bundled icon URLs keyed by language identifier */
const BUNDLED_ICONS: Record<string, string> = {
  typescript: typescriptIcon,
  javascript: javascriptIcon,
  python: pythonIcon,
  go: goIcon,
  rust: rustIcon,
  swift: swiftIcon,
  java: javaIcon,
  kotlin: kotlinIcon,
  c: cIcon,
  cpp: cppIcon,
  csharp: csharpIcon
}

/** Fallback colored badges for languages without a bundled icon */
export const LANGUAGE_MAP: Record<string, LanguageConfig> = {
  typescript: { label: 'TS', bg: 'bg-blue-600', text: 'text-white' },
  javascript: { label: 'JS', bg: 'bg-yellow-500', text: 'text-black' },
  python: { label: 'Py', bg: 'bg-sky-600', text: 'text-yellow-300' },
  go: { label: 'Go', bg: 'bg-cyan-600', text: 'text-white' },
  rust: { label: 'Rs', bg: 'bg-orange-600', text: 'text-white' },
  ruby: { label: 'Rb', bg: 'bg-red-600', text: 'text-white' },
  swift: { label: 'Sw', bg: 'bg-orange-500', text: 'text-white' },
  java: { label: 'Jv', bg: 'bg-red-500', text: 'text-white' },
  php: { label: 'PH', bg: 'bg-indigo-500', text: 'text-white' },
  elixir: { label: 'Ex', bg: 'bg-purple-600', text: 'text-white' },
  dart: { label: 'Dt', bg: 'bg-teal-500', text: 'text-white' },
  kotlin: { label: 'Kt', bg: 'bg-violet-600', text: 'text-white' },
  c: { label: 'C', bg: 'bg-gray-600', text: 'text-white' },
  cpp: { label: 'C+', bg: 'bg-blue-700', text: 'text-white' },
  csharp: { label: 'C#', bg: 'bg-green-600', text: 'text-white' }
}

// Module-level cache for user-override icon data URLs (from DB setting)
let customIconsCache: Record<string, string> | null = null
let customIconsLoading = false
const customIconsListeners: Array<() => void> = []

function loadCustomIcons(): void {
  if (customIconsCache !== null || customIconsLoading) return
  customIconsLoading = true
  projectApi
    .loadLanguageIcons()
    .then((icons) => {
      customIconsCache = icons
      customIconsLoading = false
      for (const listener of customIconsListeners) listener()
      customIconsListeners.length = 0
    })
    .catch(() => {
      customIconsCache = {}
      customIconsLoading = false
    })
}

function useCustomIcons(): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>(customIconsCache ?? {})

  useEffect(() => {
    if (customIconsCache !== null) {
      setIcons(customIconsCache)
      return
    }
    loadCustomIcons()
    const listener = (): void => setIcons(customIconsCache ?? {})
    customIconsListeners.push(listener)
  }, [])

  return icons
}

// Icon file lookups in flight (cache key -> request). Icons that mount together — every ticket
// card of a project, each tile of a connection project's icon — share one lookup per file.
const iconRequests = new Map<string, Promise<string | null>>()

function requestIconOnce(key: string, load: () => Promise<string | null>): Promise<string | null> {
  let request = iconRequests.get(key)
  if (!request) {
    request = Promise.resolve(load()).finally(() => iconRequests.delete(key))
    iconRequests.set(key, request)
  }
  return request
}

// Module-level cache for resolved project icon paths (filename -> data URL)
const projectIconCache = new Map<string, string>()

/**
 * Resolve a project's custom icon filename (projects.custom_icon) to a data URL.
 * Returns null while loading or when the project has no custom icon.
 */
export function useProjectIconUrl(customIcon: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(
    customIcon ? (projectIconCache.get(customIcon) ?? null) : null
  )

  useEffect(() => {
    if (!customIcon) {
      setUrl(null)
      return
    }

    // Check cache first
    const cached = projectIconCache.get(customIcon)
    if (cached) {
      setUrl(cached)
      return
    }

    // Resolve to data URL via main process
    let cancelled = false
    requestIconOnce(`custom:${customIcon}`, () => projectApi.getProjectIconPath(customIcon))
      .then((dataUrl) => {
        if (cancelled) return
        if (dataUrl) {
          projectIconCache.set(customIcon, dataUrl)
          setUrl(dataUrl)
        } else {
          // The file is gone: drop the image of the icon this one replaced
          setUrl(null)
        }
      })
      .catch(() => {
        // ignore errors
      })

    return () => {
      cancelled = true
    }
  }, [customIcon])

  return url
}

// Module-level cache for resolved detected icon paths (absolute path -> data URL)
const detectedIconCache = new Map<string, string>()

function useDetectedIconUrl(detectedIcon: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(
    detectedIcon && detectedIcon !== 'none' ? (detectedIconCache.get(detectedIcon) ?? null) : null
  )

  useEffect(() => {
    if (!detectedIcon || detectedIcon === 'none') {
      setUrl(null)
      return
    }

    // Check cache first
    const cached = detectedIconCache.get(detectedIcon)
    if (cached) {
      setUrl(cached)
      return
    }

    // Resolve to data URL via main process
    let cancelled = false
    requestIconOnce(`detected:${detectedIcon}`, () =>
      projectApi.getAbsoluteIconDataUrl(detectedIcon)
    )
      .then((dataUrl) => {
        if (cancelled) return
        if (dataUrl) {
          detectedIconCache.set(detectedIcon, dataUrl)
          setUrl(dataUrl)
        } else {
          setUrl(null)
        }
      })
      .catch(() => {
        // ignore errors
      })

    return () => {
      cancelled = true
    }
  }, [detectedIcon])

  return url
}

/** What a project's icon resolves to right now, following the LanguageIcon priority chain. */
export type ResolvedProjectIcon =
  | { kind: 'image'; src: string; source: 'custom' | 'detected' | 'language' }
  | { kind: 'badge'; config: LanguageConfig }
  | { kind: 'generic' }

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key)

/**
 * Resolve a project's icon: custom icon file → auto-detected favicon → user-override language
 * icon → bundled language icon → colored language badge → generic glyph. Custom and favicon
 * images load asynchronously; until they arrive (or when the file is missing) the result is
 * whatever the language resolves to.
 */
export function useResolvedProjectIcon(
  language: string | null | undefined,
  customIcon?: string | null,
  detectedIcon?: string | null
): ResolvedProjectIcon {
  const customIcons = useCustomIcons()
  const projectIconUrl = useProjectIconUrl(customIcon)
  const detectedIconUrl = useDetectedIconUrl(detectedIcon)

  // Priority 1: Custom project icon (per-project image file)
  if (customIcon && typeof projectIconUrl === 'string' && projectIconUrl) {
    return { kind: 'image', src: projectIconUrl, source: 'custom' }
  }

  // Priority 2: Auto-detected favicon
  if (
    detectedIcon &&
    detectedIcon !== 'none' &&
    typeof detectedIconUrl === 'string' &&
    detectedIconUrl
  ) {
    return { kind: 'image', src: detectedIconUrl, source: 'detected' }
  }

  if (!language) return { kind: 'generic' }

  // Priority 3: User-override language icon (from DB language_icons setting)
  const userOverrideUrl = hasOwn(customIcons, language) ? customIcons[language] : null
  if (typeof userOverrideUrl === 'string' && userOverrideUrl) {
    return { kind: 'image', src: userOverrideUrl, source: 'language' }
  }

  // Priority 4: Bundled language icon (shipped with the app)
  if (hasOwn(BUNDLED_ICONS, language)) {
    return { kind: 'image', src: BUNDLED_ICONS[language], source: 'language' }
  }

  // Priority 5: Colored badge fallback
  if (hasOwn(LANGUAGE_MAP, language)) return { kind: 'badge', config: LANGUAGE_MAP[language] }

  return { kind: 'generic' }
}

export function LanguageIcon({
  language,
  customIcon,
  detectedIcon,
  className
}: LanguageIconProps): React.JSX.Element {
  const icon = useResolvedProjectIcon(language, customIcon, detectedIcon)

  if (icon.kind === 'image') {
    if (icon.source === 'custom') {
      return (
        <img
          src={icon.src}
          alt="project icon"
          title="Custom project icon"
          className={cn('h-4 w-4 shrink-0 object-contain rounded-sm', className)}
        />
      )
    }
    if (icon.source === 'detected') {
      return (
        <img
          src={icon.src}
          alt="project favicon"
          title="Auto-detected favicon"
          className={cn('h-4 w-4 shrink-0 object-contain rounded-sm', className)}
        />
      )
    }
    return (
      <img
        src={icon.src}
        alt={language ?? ''}
        title={language ?? undefined}
        className={cn('h-4 w-4 shrink-0 object-contain', className)}
      />
    )
  }

  if (icon.kind === 'badge') {
    return (
      <div
        className={cn(
          'h-4 w-4 shrink-0 rounded-sm flex items-center justify-center',
          icon.config.bg,
          className
        )}
        title={language ?? undefined}
      >
        <span className={cn('text-[8px] font-bold leading-none', icon.config.text)}>
          {icon.config.label}
        </span>
      </div>
    )
  }

  return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
}
