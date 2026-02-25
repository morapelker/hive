import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import {
  FileText,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  AlertTriangle,
  Info,
  Circle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_ITEMS = 20

type LspOperation =
  | 'goToDefinition'
  | 'hover'
  | 'findReferences'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'incomingCalls'
  | 'outgoingCalls'
  | 'diagnostics'

// --- Helpers ---

/** Convert file:// URI to a filesystem path */
function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(uri.slice(7))
    } catch {
      return uri.slice(7)
    }
  }
  return uri
}

/** Shorten a file path to last 2 segments */
function shortenPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath
}

/** Map LSP SymbolKind number to a short label */
function symbolKindLabel(kind: number): string {
  const map: Record<number, string> = {
    1: 'file',
    2: 'module',
    3: 'namespace',
    4: 'package',
    5: 'class',
    6: 'method',
    7: 'property',
    8: 'field',
    9: 'constructor',
    10: 'enum',
    11: 'interface',
    12: 'function',
    13: 'variable',
    14: 'constant',
    15: 'string',
    16: 'number',
    17: 'boolean',
    18: 'array',
    19: 'object',
    20: 'key',
    21: 'null',
    22: 'enum member',
    23: 'struct',
    24: 'event',
    25: 'operator',
    26: 'type param'
  }
  return map[kind] || `kind:${kind}`
}

/** Color for symbol kind badge */
function symbolKindColor(kind: number): string {
  if ([5, 11, 23].includes(kind)) return 'bg-purple-500/15 text-purple-500 dark:text-purple-400' // class/interface/struct
  if ([6, 9, 12].includes(kind)) return 'bg-blue-500/15 text-blue-500 dark:text-blue-400' // method/constructor/function
  if ([7, 8, 13, 14].includes(kind)) return 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400' // property/field/variable/constant
  if ([10, 22].includes(kind)) return 'bg-amber-500/15 text-amber-500 dark:text-amber-400' // enum/enum member
  if ([2, 3, 4].includes(kind)) return 'bg-cyan-500/15 text-cyan-500 dark:text-cyan-400' // module/namespace/package
  return 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
}

/** Severity icon for diagnostics */
function SeverityIcon({ severity }: { severity: number }): React.JSX.Element {
  const iconClass = 'h-3 w-3 shrink-0'
  switch (severity) {
    case 1:
      return <AlertCircle className={cn(iconClass, 'text-red-500')} />
    case 2:
      return <AlertTriangle className={cn(iconClass, 'text-yellow-500')} />
    case 3:
      return <Info className={cn(iconClass, 'text-blue-400')} />
    default:
      return <Circle className={cn(iconClass, 'text-zinc-400')} />
  }
}

/** Try to parse JSON output, return null on failure */
function tryParseJson(output: string): unknown | null {
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

/** Extract hover content as a string */
function extractHoverContent(data: unknown[]): string {
  const parts: string[] = []
  for (const item of data) {
    const obj = item as Record<string, unknown>
    const contents = obj?.contents as Record<string, unknown> | string | undefined
    if (typeof contents === 'string') {
      parts.push(contents)
    } else if (contents && typeof contents === 'object') {
      if (typeof contents.value === 'string') {
        parts.push(contents.value)
      }
    }
  }
  return parts.join('\n\n')
}

/** Detect language from a markdown code fence */
function detectLanguage(text: string): string | null {
  const match = text.match(/^```(\w+)\n/)
  return match ? match[1] : null
}

/** Strip markdown code fences */
function stripFences(text: string): string {
  return text.replace(/^```\w*\n/, '').replace(/\n```\s*$/, '')
}

// --- Sub-renderers ---

/** Location list (goToDefinition, findReferences, goToImplementation) */
function LocationList({
  items,
  showAll,
  onToggle
}: {
  items: unknown[]
  showAll: boolean
  onToggle: () => void
}) {
  const locations = items.map((item) => {
    const loc = item as Record<string, unknown>
    const uri = (loc.uri || loc.targetUri || '') as string
    const range = (loc.range || loc.targetRange || {}) as Record<string, unknown>
    const start = (range.start || {}) as Record<string, number>
    return {
      path: uriToPath(uri),
      line: (start.line ?? 0) + 1
    }
  })

  const needsTruncation = locations.length > MAX_PREVIEW_ITEMS
  const displayed = showAll ? locations : locations.slice(0, MAX_PREVIEW_ITEMS)

  return (
    <div>
      <div className="space-y-0.5">
        {displayed.map((loc, i) => (
          <div key={i} className="flex items-center gap-1.5 py-px hover:bg-muted/30 rounded-sm">
            <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs text-muted-foreground truncate">
              {shortenPath(loc.path)}
              <span className="text-foreground">:{loc.line}</span>
            </span>
          </div>
        ))}
      </div>
      {needsTruncation && (
        <ShowAllButton
          showAll={showAll}
          count={locations.length}
          label="locations"
          onToggle={onToggle}
        />
      )}
    </div>
  )
}

/** Hover info display */
function HoverView({ data }: { data: unknown[] }) {
  const content = extractHoverContent(data)
  if (!content) {
    return <div className="text-muted-foreground text-xs italic">No hover information</div>
  }

  const lang = detectLanguage(content)
  if (lang) {
    const code = stripFences(content)
    return (
      <div className="rounded-md overflow-hidden">
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          customStyle={{
            margin: 0,
            borderRadius: '0.375rem',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '8px 12px'
          }}
          codeTagProps={{
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
            }
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    )
  }

  return (
    <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
      {content}
    </pre>
  )
}

/** Call hierarchy display (incoming/outgoing) */
function CallHierarchyList({
  items,
  direction,
  showAll,
  onToggle
}: {
  items: unknown[]
  direction: 'incoming' | 'outgoing'
  showAll: boolean
  onToggle: () => void
}) {
  const calls = items.map((item) => {
    const obj = item as Record<string, unknown>
    const target = (direction === 'incoming' ? obj.from : obj.to) as Record<string, unknown> | undefined
    const name = (target?.name || 'unknown') as string
    const uri = (target?.uri || '') as string
    const range = (target?.range || target?.selectionRange || {}) as Record<string, unknown>
    const start = (range.start || {}) as Record<string, number>
    return {
      name,
      path: uriToPath(uri),
      line: (start.line ?? 0) + 1
    }
  })

  const Arrow = direction === 'incoming' ? ArrowLeft : ArrowRight
  const needsTruncation = calls.length > MAX_PREVIEW_ITEMS
  const displayed = showAll ? calls : calls.slice(0, MAX_PREVIEW_ITEMS)

  return (
    <div>
      <div className="space-y-0.5">
        {displayed.map((call, i) => (
          <div key={i} className="flex items-center gap-1.5 py-px hover:bg-muted/30 rounded-sm">
            <Arrow className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground">{call.name}()</span>
            {call.path && (
              <span className="font-mono text-xs text-muted-foreground truncate">
                {shortenPath(call.path)}:{call.line}
              </span>
            )}
          </div>
        ))}
      </div>
      {needsTruncation && (
        <ShowAllButton
          showAll={showAll}
          count={calls.length}
          label="calls"
          onToggle={onToggle}
        />
      )}
    </div>
  )
}

/** Symbol list (documentSymbol, workspaceSymbol) */
function SymbolList({
  items,
  showFilePath,
  showAll,
  onToggle
}: {
  items: unknown[]
  showFilePath: boolean
  showAll: boolean
  onToggle: () => void
}) {
  const symbols = flattenSymbols(items)
  const needsTruncation = symbols.length > MAX_PREVIEW_ITEMS
  const displayed = showAll ? symbols : symbols.slice(0, MAX_PREVIEW_ITEMS)

  return (
    <div>
      <div className="space-y-0.5">
        {displayed.map((sym, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 py-px hover:bg-muted/30 rounded-sm"
            style={sym.depth > 0 ? { paddingLeft: `${sym.depth * 12}px` } : undefined}
          >
            <span
              className={cn(
                'text-[9px] rounded px-1 py-0.5 font-medium shrink-0 min-w-[3.5rem] text-center',
                symbolKindColor(sym.kind)
              )}
            >
              {symbolKindLabel(sym.kind)}
            </span>
            <span className="text-xs font-medium text-foreground truncate">{sym.name}</span>
            {sym.line !== null && (
              <span className="text-[10px] text-muted-foreground shrink-0">L:{sym.line}</span>
            )}
            {showFilePath && sym.path && (
              <span className="font-mono text-[10px] text-muted-foreground truncate">
                {shortenPath(sym.path)}
              </span>
            )}
          </div>
        ))}
      </div>
      {needsTruncation && (
        <ShowAllButton
          showAll={showAll}
          count={symbols.length}
          label="symbols"
          onToggle={onToggle}
        />
      )}
    </div>
  )
}

/** Flatten nested document symbols into a flat list */
function flattenSymbols(
  items: unknown[],
  depth = 0
): Array<{ name: string; kind: number; line: number | null; path: string | null; depth: number }> {
  const result: Array<{
    name: string
    kind: number
    line: number | null
    path: string | null
    depth: number
  }> = []
  for (const item of items) {
    const obj = item as Record<string, unknown>
    const name = (obj.name || '') as string
    const kind = (obj.kind || 0) as number
    const range = (obj.range || obj.selectionRange || {}) as Record<string, unknown>
    const start = (range.start || {}) as Record<string, number>
    const location = obj.location as Record<string, unknown> | undefined
    const locUri = (location?.uri || '') as string
    const locRange = (location?.range || {}) as Record<string, unknown>
    const locStart = (locRange.start || {}) as Record<string, number>

    const line =
      start.line !== undefined ? start.line + 1 : locStart.line !== undefined ? locStart.line + 1 : null
    const path = locUri ? uriToPath(locUri) : null

    result.push({ name, kind, line, path, depth })

    const children = obj.children as unknown[] | undefined
    if (children && Array.isArray(children)) {
      result.push(...flattenSymbols(children, depth + 1))
    }
  }
  return result
}

/** Flatten diagnostics into a renderable list grouped by file */
function flattenDiagnostics(
  data: Record<string, unknown[]>
): Array<{
  filePath: string
  severity: number
  message: string
  line: number | null
}> {
  const result: Array<{
    filePath: string
    severity: number
    message: string
    line: number | null
  }> = []
  for (const [filePath, diags] of Object.entries(data)) {
    for (const diag of diags as Array<Record<string, unknown>>) {
      const severity = (diag.severity || 4) as number
      const message = (diag.message || '') as string
      const range = (diag.range || {}) as Record<string, unknown>
      const start = (range.start || {}) as Record<string, number>
      const line = start.line !== undefined ? start.line + 1 : null
      result.push({ filePath, severity, message, line })
    }
  }
  return result
}

/** Diagnostics display grouped by file */
function DiagnosticsView({
  data,
  showAll,
  onToggle
}: {
  data: Record<string, unknown[]>
  showAll: boolean
  onToggle: () => void
}) {
  const allDiags = flattenDiagnostics(data)
  const needsTruncation = allDiags.length > MAX_PREVIEW_ITEMS
  const displayed = showAll ? allDiags : allDiags.slice(0, MAX_PREVIEW_ITEMS)

  // Group displayed diagnostics by file for rendering
  const grouped: Array<{ filePath: string; items: typeof displayed }> = []
  for (const diag of displayed) {
    const last = grouped[grouped.length - 1]
    if (last && last.filePath === diag.filePath) {
      last.items.push(diag)
    } else {
      grouped.push({ filePath: diag.filePath, items: [diag] })
    }
  }

  return (
    <div>
      <div className="space-y-2">
        {grouped.map(({ filePath, items }) => (
          <div key={filePath}>
            <div className="font-mono text-xs text-foreground font-medium mb-0.5">
              {shortenPath(filePath)}
            </div>
            <div className="space-y-0.5 ml-2">
              {items.map((diag, i) => (
                <div key={i} className="flex items-start gap-1.5 py-px">
                  <SeverityIcon severity={diag.severity} />
                  {diag.line !== null && (
                    <span className="text-[10px] text-muted-foreground shrink-0 min-w-[2rem]">
                      L:{diag.line}
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted-foreground break-all">
                    {diag.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {needsTruncation && (
        <ShowAllButton
          showAll={showAll}
          count={allDiags.length}
          label="diagnostics"
          onToggle={onToggle}
        />
      )}
    </div>
  )
}

/** Reusable "Show all / Show less" toggle button */
function ShowAllButton({
  showAll,
  count,
  label,
  onToggle
}: {
  showAll: boolean
  count: number
  label: string
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1 mt-2 text-blue-500 hover:text-blue-400 text-xs font-medium transition-colors"
      data-testid="show-all-button"
    >
      <ChevronDown
        className={cn('h-3 w-3 transition-transform duration-150', showAll && 'rotate-180')}
      />
      {showAll ? 'Show less' : `Show all ${count} ${label}`}
    </button>
  )
}

// --- Main Component ---

export function LspToolView({ input, output, error }: ToolViewProps) {
  const [showAll, setShowAll] = useState(false)

  const operation = (input.operation || '') as LspOperation

  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all">{error}</div>
    )
  }

  if (!output) return null

  // Handle "No results found" / "No diagnostics found"
  if (output === 'No results found' || output === 'No diagnostics found') {
    return <div className="text-muted-foreground text-xs italic">{output}</div>
  }

  const parsed = tryParseJson(output)
  if (parsed === null) {
    // Fallback: show raw output
    return (
      <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
        {output}
      </pre>
    )
  }

  const toggleShowAll = () => setShowAll(!showAll)

  // Route to operation-specific renderer
  switch (operation) {
    case 'goToDefinition':
    case 'findReferences':
    case 'goToImplementation':
      return (
        <div data-testid="lsp-tool-view">
          <LocationList
            items={parsed as unknown[]}
            showAll={showAll}
            onToggle={toggleShowAll}
          />
        </div>
      )

    case 'hover':
      return (
        <div data-testid="lsp-tool-view">
          <HoverView data={parsed as unknown[]} />
        </div>
      )

    case 'incomingCalls':
      return (
        <div data-testid="lsp-tool-view">
          <CallHierarchyList
            items={parsed as unknown[]}
            direction="incoming"
            showAll={showAll}
            onToggle={toggleShowAll}
          />
        </div>
      )

    case 'outgoingCalls':
      return (
        <div data-testid="lsp-tool-view">
          <CallHierarchyList
            items={parsed as unknown[]}
            direction="outgoing"
            showAll={showAll}
            onToggle={toggleShowAll}
          />
        </div>
      )

    case 'documentSymbol':
      return (
        <div data-testid="lsp-tool-view">
          <SymbolList
            items={parsed as unknown[]}
            showFilePath={false}
            showAll={showAll}
            onToggle={toggleShowAll}
          />
        </div>
      )

    case 'workspaceSymbol':
      return (
        <div data-testid="lsp-tool-view">
          <SymbolList
            items={parsed as unknown[]}
            showFilePath={true}
            showAll={showAll}
            onToggle={toggleShowAll}
          />
        </div>
      )

    case 'diagnostics':
      return (
        <div data-testid="lsp-tool-view">
          <DiagnosticsView
            data={parsed as Record<string, unknown[]>}
            showAll={showAll}
            onToggle={toggleShowAll}
          />
        </div>
      )

    default:
      // Unknown operation — show raw JSON
      return (
        <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
          {output}
        </pre>
      )
  }
}

// --- Exported helpers for ToolCard collapsed content ---

const OPERATION_LABELS: Record<string, string> = {
  goToDefinition: 'definition',
  hover: 'hover',
  findReferences: 'references',
  documentSymbol: 'symbols',
  workspaceSymbol: 'workspace symbols',
  goToImplementation: 'implementation',
  incomingCalls: 'callers',
  outgoingCalls: 'callees',
  diagnostics: 'diagnostics'
}

const OPERATION_COLORS: Record<string, string> = {
  goToDefinition: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  goToImplementation: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  hover: 'bg-purple-500/15 text-purple-500 dark:text-purple-400',
  findReferences: 'bg-amber-500/15 text-amber-500 dark:text-amber-400',
  documentSymbol: 'bg-teal-500/15 text-teal-500 dark:text-teal-400',
  workspaceSymbol: 'bg-teal-500/15 text-teal-500 dark:text-teal-400',
  incomingCalls: 'bg-cyan-500/15 text-cyan-500 dark:text-cyan-400',
  outgoingCalls: 'bg-cyan-500/15 text-cyan-500 dark:text-cyan-400',
  diagnostics: 'bg-red-500/15 text-red-500 dark:text-red-400'
}

/** Get human-readable label for an LSP operation */
export function getLspOperationLabel(operation: string): string {
  return OPERATION_LABELS[operation] || operation
}

/** Get badge color class for an LSP operation */
export function getLspOperationColor(operation: string): string {
  return OPERATION_COLORS[operation] || 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
}

/** Count results from LSP output */
export function getLspResultCount(output: string | undefined): number | null {
  if (!output || output === 'No results found' || output === 'No diagnostics found') return null
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) return parsed.length
    if (typeof parsed === 'object' && parsed !== null) {
      // diagnostics: count total across all files
      return Object.values(parsed).reduce(
        (sum: number, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0
      )
    }
  } catch {
    // ignore
  }
  return null
}
