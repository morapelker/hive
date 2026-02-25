/**
 * Maps file extensions to LSP language identifiers.
 * Ported from OpenCode's packages/opencode/src/lsp/language.ts
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  // TypeScript / JavaScript
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',

  // Go
  '.go': 'go',
  '.mod': 'go.mod',
  '.sum': 'go.sum',

  // Python
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',

  // Rust
  '.rs': 'rust',

  // C / C++
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.hh': 'cpp',

  // Java / Kotlin
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',

  // C#
  '.cs': 'csharp',

  // Ruby
  '.rb': 'ruby',
  '.erb': 'erb',

  // PHP
  '.php': 'php',

  // Swift
  '.swift': 'swift',

  // Lua
  '.lua': 'lua',

  // Shell
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',

  // Dart
  '.dart': 'dart',

  // Elixir
  '.ex': 'elixir',
  '.exs': 'elixir',

  // Zig
  '.zig': 'zig',

  // Scala
  '.scala': 'scala',
  '.sc': 'scala',

  // Haskell
  '.hs': 'haskell',

  // OCaml
  '.ml': 'ocaml',
  '.mli': 'ocaml',

  // Clojure
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',

  // HTML / CSS
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',

  // JSON / YAML / TOML
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',

  // Markdown
  '.md': 'markdown',
  '.mdx': 'mdx',

  // Vue / Svelte
  '.vue': 'vue',
  '.svelte': 'svelte',

  // Terraform
  '.tf': 'terraform',
  '.tfvars': 'terraform',

  // Protobuf
  '.proto': 'proto3',

  // SQL
  '.sql': 'sql',

  // XML
  '.xml': 'xml',
  '.xsl': 'xml',
  '.xsd': 'xml',

  // R
  '.r': 'r',
  '.R': 'r',

  // Nim
  '.nim': 'nim',

  // V
  '.v': 'v',
}
