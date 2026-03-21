import type { Extension } from '@codemirror/state'
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

const extensionMap: Record<string, () => Extension> = {
  '.ts': () => javascript({ typescript: true }),
  '.tsx': () => javascript({ typescript: true, jsx: true }),
  '.js': () => javascript(),
  '.jsx': () => javascript({ jsx: true }),
  '.mjs': () => javascript(),
  '.cjs': () => javascript(),
  '.json': () => json(),
  '.jsonc': () => json(),
  '.md': () => markdown(),
  '.mdx': () => markdown(),
  '.css': () => css(),
  '.scss': () => css(),
  '.sass': () => css(),
  '.less': () => css(),
  '.html': () => html(),
  '.htm': () => html(),
  '.xml': () => xml(),
  '.svg': () => xml(),
  '.vue': () => html(),
  '.svelte': () => html(),
  '.py': () => python(),
  '.rs': () => rust(),
  '.java': () => java(),
  '.kt': () => java(),
  '.kts': () => java(),
  '.c': () => cpp(),
  '.h': () => cpp(),
  '.cpp': () => cpp(),
  '.hpp': () => cpp(),
  '.cc': () => cpp(),
  '.sql': () => sql()
}

export function getLanguageExtension(filePath: string): Extension {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  const factory = extensionMap[ext]
  return factory ? factory() : []
}
