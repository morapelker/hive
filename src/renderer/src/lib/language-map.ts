/**
 * Shared language detection and mapping utility.
 *
 * Single source of truth for file-extension-to-language mapping, consumed by
 * CodeMirror, Prism (react-syntax-highlighter), and Monaco adapters.
 */
import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { go } from '@codemirror/legacy-modes/mode/go'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'
import { erlang } from '@codemirror/legacy-modes/mode/erlang'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { elm } from '@codemirror/legacy-modes/mode/elm'
import { r } from '@codemirror/legacy-modes/mode/r'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import {
  csharp,
  scala,
  dart,
  kotlin as kotlinLang
} from '@codemirror/legacy-modes/mode/clike'

// ---------------------------------------------------------------------------
// 2a. Canonical extension → language ID map
// ---------------------------------------------------------------------------

const extensionMap: Record<string, string> = {
  // JavaScript / TypeScript
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',

  // Data / Config
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'shell',

  // Markup / Markdown
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.vue': 'html',
  '.svelte': 'html',

  // Stylesheets
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',

  // Systems languages
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.zig': 'zig',

  // JVM
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.clj': 'clojure',

  // .NET
  '.cs': 'csharp',

  // Scripting
  '.py': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.elm': 'elm',
  '.dart': 'dart',
  '.swift': 'swift',

  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',

  // Infrastructure / Schema
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.proto': 'protobuf'
}

// ---------------------------------------------------------------------------
// 2b + 2c. Language detection
// ---------------------------------------------------------------------------

/**
 * Get the canonical language ID for any file path.
 * Checks filename-based patterns first, then falls back to extension matching.
 */
export function getLanguageId(filePath: string): string {
  const name = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()

  // Filename-based detection (before extension matching)
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  if (name === '.env' || name.startsWith('.env.')) return 'shell'
  if (name === '.gitignore' || name === '.dockerignore') return 'shell'

  // Extension-based detection
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1) return 'plaintext'
  const ext = filePath.substring(dotIndex).toLowerCase()
  return extensionMap[ext] || 'plaintext'
}

// ---------------------------------------------------------------------------
// 2d. Adapter functions
// ---------------------------------------------------------------------------

/** Map canonical language IDs to Prism identifiers. */
export function getPrismLanguage(filePath: string): string {
  const id = getLanguageId(filePath)
  switch (id) {
    case 'shell':
      return 'bash'
    case 'dockerfile':
      return 'docker'
    case 'plaintext':
      return 'text'
    default:
      return id
  }
}

/** Map canonical language IDs to Monaco editor language IDs. */
export function getMonacoLanguage(filePath: string): string {
  const id = getLanguageId(filePath)
  switch (id) {
    case 'tsx':
      return 'typescript'
    case 'jsx':
      return 'javascript'
    case 'toml':
      return 'ini'
    case 'makefile':
      return 'plaintext'
    default:
      return id
  }
}

// CodeMirror language factories keyed by canonical language ID.
// Only languages with a CM6 mode are listed; unknown IDs gracefully return [].
const codeMirrorFactories: Record<string, () => Extension> = {
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  json: () => json(),
  markdown: () => markdown(),
  css: () => css(),
  scss: () => css(),
  sass: () => css(),
  less: () => css(),
  html: () => html(),
  xml: () => xml(),
  python: () => python(),
  rust: () => rust(),
  java: () => java(),
  c: () => cpp(),
  cpp: () => cpp(),
  sql: () => sql(),
  yaml: () => yaml(),
  toml: () => StreamLanguage.define(toml),
  shell: () => StreamLanguage.define(shell),
  go: () => StreamLanguage.define(go),
  ruby: () => StreamLanguage.define(ruby),
  lua: () => StreamLanguage.define(lua),
  swift: () => StreamLanguage.define(swift),
  clojure: () => StreamLanguage.define(clojure),
  erlang: () => StreamLanguage.define(erlang),
  haskell: () => StreamLanguage.define(haskell),
  elm: () => StreamLanguage.define(elm),
  r: () => StreamLanguage.define(r),
  powershell: () => StreamLanguage.define(powerShell),
  protobuf: () => StreamLanguage.define(protobuf),
  dockerfile: () => StreamLanguage.define(dockerFile),
  csharp: () => StreamLanguage.define(csharp),
  scala: () => StreamLanguage.define(scala),
  kotlin: () => StreamLanguage.define(kotlinLang),
  dart: () => StreamLanguage.define(dart)
}

/** Get a CodeMirror Extension for syntax highlighting the given file path. */
export function getCodeMirrorExtension(filePath: string): Extension {
  const id = getLanguageId(filePath)
  const factory = codeMirrorFactories[id]
  return factory ? factory() : []
}
