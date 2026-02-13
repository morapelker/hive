import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  FileImage,
  Folder,
  FolderOpen,
  Package,
  Settings,
  Database,
  FileVideo,
  FileAudio,
  Terminal,
  Lock,
  FileArchive,
  BookOpen,
  Braces,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface FileIconProps {
  name: string
  extension: string | null
  isDirectory: boolean
  isExpanded?: boolean
  className?: string
}

// Map of file extensions to icons
const extensionIconMap: Record<string, LucideIcon> = {
  // TypeScript/JavaScript
  '.ts': FileCode,
  '.tsx': FileCode,
  '.js': FileCode,
  '.jsx': FileCode,
  '.mjs': FileCode,
  '.cjs': FileCode,
  '.mts': FileCode,
  '.cts': FileCode,

  // JSON/Config
  '.json': FileJson,
  '.jsonc': FileJson,
  '.json5': FileJson,

  // Markdown/Text
  '.md': FileText,
  '.mdx': FileText,
  '.txt': FileText,
  '.rtf': FileText,

  // CSS/Styling
  '.css': Braces,
  '.scss': Braces,
  '.sass': Braces,
  '.less': Braces,
  '.styl': Braces,
  '.stylus': Braces,

  // HTML/Templates
  '.html': FileCode,
  '.htm': FileCode,
  '.vue': FileCode,
  '.svelte': FileCode,
  '.astro': FileCode,

  // Images
  '.png': FileImage,
  '.jpg': FileImage,
  '.jpeg': FileImage,
  '.gif': FileImage,
  '.svg': FileImage,
  '.webp': FileImage,
  '.ico': FileImage,
  '.bmp': FileImage,

  // Video
  '.mp4': FileVideo,
  '.webm': FileVideo,
  '.avi': FileVideo,
  '.mov': FileVideo,
  '.mkv': FileVideo,

  // Audio
  '.mp3': FileAudio,
  '.wav': FileAudio,
  '.ogg': FileAudio,
  '.flac': FileAudio,

  // Database
  '.sql': Database,
  '.sqlite': Database,
  '.db': Database,

  // Shell/Scripts
  '.sh': Terminal,
  '.bash': Terminal,
  '.zsh': Terminal,
  '.fish': Terminal,
  '.ps1': Terminal,
  '.bat': Terminal,
  '.cmd': Terminal,

  // Archives
  '.zip': FileArchive,
  '.tar': FileArchive,
  '.gz': FileArchive,
  '.bz2': FileArchive,
  '.7z': FileArchive,
  '.rar': FileArchive,

  // Fonts
  '.ttf': FileType,
  '.otf': FileType,
  '.woff': FileType,
  '.woff2': FileType,
  '.eot': FileType,

  // Config files (by extension)
  '.yaml': Settings,
  '.yml': Settings,
  '.toml': Settings,
  '.ini': Settings,
  '.env': Lock,

  // Documentation
  '.pdf': BookOpen,
  '.doc': BookOpen,
  '.docx': BookOpen,

  // Python
  '.py': FileCode,
  '.pyx': FileCode,
  '.pyi': FileCode,

  // Ruby
  '.rb': FileCode,
  '.erb': FileCode,

  // Go
  '.go': FileCode,

  // Rust
  '.rs': FileCode,

  // Java/Kotlin
  '.java': FileCode,
  '.kt': FileCode,
  '.kts': FileCode,

  // C/C++
  '.c': FileCode,
  '.h': FileCode,
  '.cpp': FileCode,
  '.hpp': FileCode,
  '.cc': FileCode,
  '.cxx': FileCode,

  // C#
  '.cs': FileCode,

  // PHP
  '.php': FileCode,

  // Swift
  '.swift': FileCode,

  // Dart
  '.dart': FileCode
}

// Map of special file names to icons
const specialFileMap: Record<string, LucideIcon> = {
  'package.json': Package,
  'package-lock.json': Lock,
  'pnpm-lock.yaml': Lock,
  'yarn.lock': Lock,
  'bun.lockb': Lock,
  'tsconfig.json': Settings,
  'jsconfig.json': Settings,
  '.eslintrc': Settings,
  '.eslintrc.js': Settings,
  '.eslintrc.json': Settings,
  '.prettierrc': Settings,
  '.prettierrc.js': Settings,
  '.prettierrc.json': Settings,
  '.gitignore': Settings,
  '.gitattributes': Settings,
  '.editorconfig': Settings,
  dockerfile: Settings,
  Dockerfile: Settings,
  'docker-compose.yml': Settings,
  'docker-compose.yaml': Settings,
  '.dockerignore': Settings,
  makefile: Terminal,
  Makefile: Terminal,
  'readme.md': FileText,
  'README.md': FileText,
  license: FileText,
  LICENSE: FileText,
  'changelog.md': FileText,
  'CHANGELOG.md': FileText,
  '.env': Lock,
  '.env.local': Lock,
  '.env.development': Lock,
  '.env.production': Lock,
  '.env.test': Lock
}

export function FileIcon({
  name,
  extension,
  isDirectory,
  isExpanded = false,
  className
}: FileIconProps): React.JSX.Element {
  // Determine the icon to use
  let Icon: LucideIcon

  if (isDirectory) {
    Icon = isExpanded ? FolderOpen : Folder
  } else {
    // Check special file names first
    const lowerName = name.toLowerCase()
    if (specialFileMap[name]) {
      Icon = specialFileMap[name]
    } else if (specialFileMap[lowerName]) {
      Icon = specialFileMap[lowerName]
    } else if (extension && extensionIconMap[extension]) {
      Icon = extensionIconMap[extension]
    } else {
      Icon = File
    }
  }

  // Determine color based on file type
  const colorClass = isDirectory
    ? 'text-amber-500'
    : extension === '.ts' || extension === '.tsx'
      ? 'text-blue-500'
      : extension === '.js' || extension === '.jsx'
        ? 'text-yellow-500'
        : extension === '.json'
          ? 'text-orange-400'
          : extension === '.css' || extension === '.scss'
            ? 'text-pink-500'
            : extension === '.md' || extension === '.txt'
              ? 'text-gray-400'
              : extension === '.html' || extension === '.vue' || extension === '.svelte'
                ? 'text-orange-500'
                : extension === '.py'
                  ? 'text-green-500'
                  : extension === '.go'
                    ? 'text-cyan-500'
                    : extension === '.rs'
                      ? 'text-orange-600'
                      : extension === '.rb'
                        ? 'text-red-500'
                        : 'text-muted-foreground'

  return <Icon className={cn('h-4 w-4 flex-shrink-0', colorClass, className)} />
}
