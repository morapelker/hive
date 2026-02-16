import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderOpen,
  Lock,
  Package,
  Settings,
  BookOpen,
  type LucideIcon
} from 'lucide-react'

// SVG icon imports (Vite resolves these to hashed asset URLs at build time)
import typescriptIcon from '@/assets/file-icons/typescript.svg'
import reactIcon from '@/assets/file-icons/react.svg'
import javascriptIcon from '@/assets/file-icons/javascript.svg'
import pythonIcon from '@/assets/file-icons/python.svg'
import goIcon from '@/assets/file-icons/go.svg'
import rustIcon from '@/assets/file-icons/rust.svg'
import swiftIcon from '@/assets/file-icons/swift.svg'
import javaIcon from '@/assets/file-icons/java.svg'
import kotlinIcon from '@/assets/file-icons/kotlin.svg'
import cIcon from '@/assets/file-icons/c.svg'
import cppIcon from '@/assets/file-icons/c-plusplus.svg'
import csharpIcon from '@/assets/file-icons/csharp.svg'
import rubyIcon from '@/assets/file-icons/ruby.svg'
import phpIcon from '@/assets/file-icons/php.svg'
import dartIcon from '@/assets/file-icons/dart.svg'
import yamlIcon from '@/assets/file-icons/yaml.svg'
import tomlIcon from '@/assets/file-icons/toml.svg'
import markdownIcon from '@/assets/file-icons/markdown.svg'
import htmlIcon from '@/assets/file-icons/html.svg'
import cssIcon from '@/assets/file-icons/css.svg'
import sassIcon from '@/assets/file-icons/sass.svg'
import vueIcon from '@/assets/file-icons/vue.svg'
import svelteIcon from '@/assets/file-icons/svelte.svg'
import dockerIcon from '@/assets/file-icons/docker.svg'
import graphqlIcon from '@/assets/file-icons/graphql.svg'
import luaIcon from '@/assets/file-icons/lua.svg'
import rLangIcon from '@/assets/file-icons/r-lang.svg'
import scalaIcon from '@/assets/file-icons/scala.svg'
import zigIcon from '@/assets/file-icons/zig.svg'
import elixirIcon from '@/assets/file-icons/elixir.svg'
import astroIcon from '@/assets/file-icons/astro.svg'
import shellIcon from '@/assets/file-icons/shell.svg'
import jsonIcon from '@/assets/file-icons/json.svg'
import sqlIcon from '@/assets/file-icons/sql.svg'
import xmlIcon from '@/assets/file-icons/xml.svg'
import haskellIcon from '@/assets/file-icons/haskell.svg'
import erlangIcon from '@/assets/file-icons/erlang.svg'
import clojureIcon from '@/assets/file-icons/clojure.svg'
import perlIcon from '@/assets/file-icons/perl.svg'

/** Maps file extensions (lowercase, with dot prefix) to bundled SVG asset URLs */
export const svgIconMap: Record<string, string> = {
  // TypeScript
  '.ts': typescriptIcon,
  '.mts': typescriptIcon,
  '.cts': typescriptIcon,

  // React (TSX/JSX)
  '.tsx': reactIcon,
  '.jsx': reactIcon,

  // JavaScript
  '.js': javascriptIcon,
  '.mjs': javascriptIcon,
  '.cjs': javascriptIcon,

  // Python
  '.py': pythonIcon,
  '.pyi': pythonIcon,
  '.pyx': pythonIcon,

  // Go
  '.go': goIcon,

  // Rust
  '.rs': rustIcon,

  // Swift
  '.swift': swiftIcon,

  // Java
  '.java': javaIcon,

  // Kotlin
  '.kt': kotlinIcon,
  '.kts': kotlinIcon,

  // C
  '.c': cIcon,
  '.h': cIcon,

  // C++
  '.cpp': cppIcon,
  '.hpp': cppIcon,
  '.cc': cppIcon,
  '.cxx': cppIcon,

  // C#
  '.cs': csharpIcon,

  // Ruby
  '.rb': rubyIcon,
  '.erb': rubyIcon,

  // PHP
  '.php': phpIcon,

  // Dart
  '.dart': dartIcon,

  // YAML
  '.yaml': yamlIcon,
  '.yml': yamlIcon,

  // TOML
  '.toml': tomlIcon,

  // Markdown
  '.md': markdownIcon,
  '.mdx': markdownIcon,

  // HTML
  '.html': htmlIcon,
  '.htm': htmlIcon,

  // CSS
  '.css': cssIcon,

  // Sass/SCSS/Less
  '.scss': sassIcon,
  '.sass': sassIcon,
  '.less': sassIcon,

  // Vue
  '.vue': vueIcon,

  // Svelte
  '.svelte': svelteIcon,

  // JSON
  '.json': jsonIcon,
  '.jsonc': jsonIcon,
  '.json5': jsonIcon,

  // GraphQL
  '.graphql': graphqlIcon,
  '.graphqls': graphqlIcon,
  '.gql': graphqlIcon,

  // Lua
  '.lua': luaIcon,

  // R
  '.r': rLangIcon,

  // Scala
  '.scala': scalaIcon,
  '.sc': scalaIcon,

  // Zig
  '.zig': zigIcon,

  // Elixir
  '.ex': elixirIcon,
  '.exs': elixirIcon,

  // Astro
  '.astro': astroIcon,

  // Shell
  '.sh': shellIcon,
  '.bash': shellIcon,
  '.zsh': shellIcon,
  '.fish': shellIcon,
  '.ps1': shellIcon,
  '.bat': shellIcon,
  '.cmd': shellIcon,

  // SQL
  '.sql': sqlIcon,
  '.sqlite': sqlIcon,

  // XML
  '.xml': xmlIcon,
  '.xsl': xmlIcon,
  '.xslt': xmlIcon,

  // Haskell
  '.hs': haskellIcon,
  '.lhs': haskellIcon,

  // Erlang
  '.erl': erlangIcon,
  '.hrl': erlangIcon,

  // Clojure
  '.clj': clojureIcon,
  '.cljs': clojureIcon,
  '.cljc': clojureIcon,
  '.edn': clojureIcon,

  // Perl
  '.pl': perlIcon,
  '.pm': perlIcon
}

/** Maps extensions to lucide icon + color for non-language file types */
export const lucideFallbackMap: Record<string, { icon: LucideIcon; color: string }> = {
  // Images
  '.png': { icon: FileImage, color: 'text-green-500' },
  '.jpg': { icon: FileImage, color: 'text-green-500' },
  '.jpeg': { icon: FileImage, color: 'text-green-500' },
  '.gif': { icon: FileImage, color: 'text-green-500' },
  '.svg': { icon: FileImage, color: 'text-green-500' },
  '.webp': { icon: FileImage, color: 'text-green-500' },
  '.ico': { icon: FileImage, color: 'text-green-500' },
  '.bmp': { icon: FileImage, color: 'text-green-500' },

  // Video
  '.mp4': { icon: FileVideo, color: 'text-purple-500' },
  '.webm': { icon: FileVideo, color: 'text-purple-500' },
  '.avi': { icon: FileVideo, color: 'text-purple-500' },
  '.mov': { icon: FileVideo, color: 'text-purple-500' },
  '.mkv': { icon: FileVideo, color: 'text-purple-500' },

  // Audio
  '.mp3': { icon: FileAudio, color: 'text-pink-500' },
  '.wav': { icon: FileAudio, color: 'text-pink-500' },
  '.ogg': { icon: FileAudio, color: 'text-pink-500' },
  '.flac': { icon: FileAudio, color: 'text-pink-500' },

  // Archives
  '.zip': { icon: FileArchive, color: 'text-orange-400' },
  '.tar': { icon: FileArchive, color: 'text-orange-400' },
  '.gz': { icon: FileArchive, color: 'text-orange-400' },
  '.bz2': { icon: FileArchive, color: 'text-orange-400' },
  '.7z': { icon: FileArchive, color: 'text-orange-400' },
  '.rar': { icon: FileArchive, color: 'text-orange-400' },

  // Fonts
  '.ttf': { icon: FileType, color: 'text-red-400' },
  '.otf': { icon: FileType, color: 'text-red-400' },
  '.woff': { icon: FileType, color: 'text-red-400' },
  '.woff2': { icon: FileType, color: 'text-red-400' },
  '.eot': { icon: FileType, color: 'text-red-400' },

  // Documentation
  '.pdf': { icon: BookOpen, color: 'text-red-500' },
  '.doc': { icon: BookOpen, color: 'text-blue-500' },
  '.docx': { icon: BookOpen, color: 'text-blue-500' },

  // Config (no language SVG)
  '.ini': { icon: Settings, color: 'text-gray-500' },
  '.styl': { icon: Settings, color: 'text-pink-500' },
  '.stylus': { icon: Settings, color: 'text-pink-500' },
  '.db': { icon: Settings, color: 'text-blue-400' },

  // Env
  '.env': { icon: Lock, color: 'text-yellow-600' },

  // Text
  '.txt': { icon: FileText, color: 'text-gray-400' },
  '.rtf': { icon: FileText, color: 'text-gray-400' }
}

interface SpecialFileEntry {
  svg?: string
  lucide?: LucideIcon
  color?: string
}

/**
 * Maps special filenames (lowercase) to SVG or lucide icon info.
 * All keys are lowercase — lookup normalizes via toLowerCase().
 */
export const specialFileMap: Record<string, SpecialFileEntry> = {
  'package.json': { lucide: Package, color: 'text-green-600' },
  'package-lock.json': { lucide: Lock, color: 'text-yellow-600' },
  'pnpm-lock.yaml': { lucide: Lock, color: 'text-yellow-600' },
  'yarn.lock': { lucide: Lock, color: 'text-yellow-600' },
  'bun.lockb': { lucide: Lock, color: 'text-yellow-600' },
  dockerfile: { svg: dockerIcon },
  'docker-compose.yml': { svg: dockerIcon },
  'docker-compose.yaml': { svg: dockerIcon },
  '.dockerignore': { lucide: Settings, color: 'text-muted-foreground' },
  makefile: { svg: shellIcon },
  'tsconfig.json': { lucide: Settings, color: 'text-blue-500' },
  'jsconfig.json': { lucide: Settings, color: 'text-yellow-500' },
  '.eslintrc': { lucide: Settings, color: 'text-purple-500' },
  '.eslintrc.js': { lucide: Settings, color: 'text-purple-500' },
  '.eslintrc.json': { lucide: Settings, color: 'text-purple-500' },
  '.eslintrc.cjs': { lucide: Settings, color: 'text-purple-500' },
  'eslint.config.js': { lucide: Settings, color: 'text-purple-500' },
  'eslint.config.mjs': { lucide: Settings, color: 'text-purple-500' },
  '.prettierrc': { lucide: Settings, color: 'text-pink-500' },
  '.prettierrc.js': { lucide: Settings, color: 'text-pink-500' },
  '.prettierrc.json': { lucide: Settings, color: 'text-pink-500' },
  '.gitignore': { lucide: Settings, color: 'text-orange-500' },
  '.gitattributes': { lucide: Settings, color: 'text-orange-500' },
  '.editorconfig': { lucide: Settings, color: 'text-muted-foreground' },
  'readme.md': { svg: markdownIcon },
  license: { lucide: FileText, color: 'text-gray-400' },
  'changelog.md': { svg: markdownIcon },
  '.env': { lucide: Lock, color: 'text-yellow-600' },
  '.env.local': { lucide: Lock, color: 'text-yellow-600' },
  '.env.development': { lucide: Lock, color: 'text-yellow-600' },
  '.env.production': { lucide: Lock, color: 'text-yellow-600' },
  '.env.test': { lucide: Lock, color: 'text-yellow-600' }
}

export type FileIconInfo =
  | { type: 'svg'; src: string }
  | { type: 'lucide'; icon: LucideIcon; colorClass: string }

/** Resolves a special file entry to a FileIconInfo, or null if entry is empty */
function resolveSpecial(entry: SpecialFileEntry): FileIconInfo | null {
  if (entry.svg) return { type: 'svg', src: entry.svg }
  if (entry.lucide) {
    return {
      type: 'lucide',
      icon: entry.lucide,
      colorClass: entry.color ?? 'text-muted-foreground'
    }
  }
  return null
}

/**
 * Determines the appropriate icon for a file based on its name, extension, and type.
 * Returns either an SVG asset URL or a lucide icon with color class.
 */
export function getFileIconInfo(
  name: string,
  extension: string | null,
  isDirectory: boolean,
  isExpanded?: boolean
): FileIconInfo {
  // Directories
  if (isDirectory) {
    return {
      type: 'lucide',
      icon: isExpanded ? FolderOpen : Folder,
      colorClass: 'text-amber-500'
    }
  }

  // Normalize for case-insensitive lookups
  const lowerName = name.toLowerCase()
  const ext = extension?.toLowerCase() ?? null

  // Check special file names (all keys stored lowercase)
  const special = specialFileMap[lowerName]
  if (special) {
    const resolved = resolveSpecial(special)
    if (resolved) return resolved
  }

  // Check .env* pattern (covers .env.anything)
  if (lowerName.startsWith('.env')) {
    return { type: 'lucide', icon: Lock, colorClass: 'text-yellow-600' }
  }

  // Check SVG icon by extension
  if (ext) {
    const svgSrc = svgIconMap[ext]
    if (svgSrc) return { type: 'svg', src: svgSrc }

    // Check lucide fallback by extension
    const fallback = lucideFallbackMap[ext]
    if (fallback) {
      return { type: 'lucide', icon: fallback.icon, colorClass: fallback.color }
    }
  }

  // Default fallback
  return { type: 'lucide', icon: File, colorClass: 'text-muted-foreground' }
}
