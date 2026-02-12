import { useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'

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
  className?: string
}

interface LanguageConfig {
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

// Module-level cache for resolved project icon paths (filename -> data URL)
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

  // Priority 2: User-override language icon (from DB language_icons setting)
  const userOverrideUrl = customIcons[language]
  if (userOverrideUrl) {
    return (
      <img
        src={userOverrideUrl}
        alt={language}
        title={language}
        className="h-4 w-4 shrink-0 object-contain"
      />
    )
  }

  // Priority 3: Bundled language icon (shipped with the app)
  const bundledUrl = BUNDLED_ICONS[language]
  if (bundledUrl) {
    return (
      <img
        src={bundledUrl}
        alt={language}
        title={language}
        className="h-4 w-4 shrink-0 object-contain"
      />
    )
  }

  // Priority 4: Colored badge fallback
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
