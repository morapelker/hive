import { useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'

interface LanguageIconProps {
  language: string | null
  customIcon?: string | null
  className?: string
}

interface LanguageConfig {
  label: string
  bg: string
  text: string
}

const LANGUAGE_MAP: Record<string, LanguageConfig> = {
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
  cpp: { label: 'C+', bg: 'bg-blue-700', text: 'text-white' },
  csharp: { label: 'C#', bg: 'bg-green-600', text: 'text-white' }
}

// Module-level cache for custom icon data URLs
let customIconsCache: Record<string, string> | null = null
let customIconsLoading = false
const customIconsListeners: Array<() => void> = []

function loadCustomIcons(): void {
  if (customIconsCache !== null || customIconsLoading) return
  customIconsLoading = true
  window.projectOps
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

// Module-level cache for resolved project icon paths (filename -> file:// URL)
const projectIconCache = new Map<string, string>()

function useProjectIconUrl(customIcon: string | null | undefined): string | null {
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
    window.projectOps
      .getProjectIconPath(customIcon)
      .then((dataUrl) => {
        if (cancelled) return
        if (dataUrl) {
          projectIconCache.set(customIcon, dataUrl)
          setUrl(dataUrl)
        }
      })
      .catch(() => {
        // ignore errors
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

export function LanguageIcon({
  language,
  customIcon,
  className
}: LanguageIconProps): React.JSX.Element {
  const customIcons = useCustomIcons()
  const projectIconUrl = useProjectIconUrl(customIcon)

  // Priority 1: Custom project icon (per-project image file)
  if (customIcon && projectIconUrl) {
    return (
      <img
        src={projectIconUrl}
        alt="project icon"
        title="Custom project icon"
        className="h-4 w-4 shrink-0 object-contain rounded-sm"
      />
    )
  }

  if (!language) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  // Priority 2: Custom language icon (global language-based icon)
  const customIconUrl = customIcons[language]
  if (customIconUrl) {
    return (
      <img
        src={customIconUrl}
        alt={language}
        title={language}
        className="h-4 w-4 shrink-0 object-contain"
      />
    )
  }

  // Priority 3: Default badge
  const config = LANGUAGE_MAP[language]
  if (!config) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  return (
    <div
      className={`h-4 w-4 shrink-0 rounded-sm flex items-center justify-center ${config.bg}`}
      title={language}
    >
      <span className={`text-[8px] font-bold leading-none ${config.text}`}>{config.label}</span>
    </div>
  )
}
