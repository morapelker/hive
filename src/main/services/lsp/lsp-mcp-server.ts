import fs from 'fs'
import path from 'path'
import type { LspService } from './lsp-service'
import type { LspOperation, LspPosition } from './lsp-types'
import { LSP_OPERATIONS } from './lsp-types'

const LSP_TOOL_DESCRIPTION = `Query language servers for code intelligence.

Available operations:
- goToDefinition: Jump to where a symbol is defined
- hover: Get type information and documentation for a symbol
- findReferences: Find all references to a symbol
- documentSymbol: List all symbols in a file
- workspaceSymbol: Search for symbols across the workspace
- goToImplementation: Jump to where an interface/type is implemented
- incomingCalls: Find functions that call the target function
- outgoingCalls: Find functions called by the target function
- diagnostics: Get all diagnostics (errors/warnings) across open files

Line and character are 1-based (first line is 1, first column is 1).
filePath can be absolute or relative to the project root.
documentSymbol only needs filePath. workspaceSymbol and diagnostics need no file/position.`

interface LspToolArgs {
  operation: LspOperation
  filePath: string
  line?: number
  character?: number
}

interface LspToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Create the LSP tool handler function.
 * Exported separately so it can be unit-tested without the SDK.
 */
export function createLspToolHandler(lspService: LspService) {
  return async (args: LspToolArgs): Promise<LspToolResult> => {
    const { operation, filePath, line, character } = args

    try {
      // Resolve absolute path
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(lspService.getProjectRoot(), filePath)

      // Operations that don't need a file path
      if (operation === 'diagnostics') {
        const diagMap = await lspService.diagnostics()
        const result: Record<string, unknown[]> = {}
        for (const [file, diags] of diagMap) {
          result[file] = diags
        }
        const entries = Object.keys(result)
        if (entries.length === 0) {
          return {
            content: [{ type: 'text', text: 'No diagnostics found' }]
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      }

      if (operation === 'workspaceSymbol') {
        const results = await lspService.workspaceSymbol(filePath || '')
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No results found' }]
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
        }
      }

      // All other operations need a file
      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: 'text', text: `File not found: ${absolutePath}` }],
          isError: true
        }
      }

      // Check if a server can handle this file
      const hasClient = await lspService.hasClients(absolutePath)
      if (!hasClient) {
        return {
          content: [
            {
              type: 'text',
              text: `No language server available for: ${absolutePath}`
            }
          ],
          isError: true
        }
      }

      // Ensure file is open on the server
      await lspService.touchFile(absolutePath, true)

      // documentSymbol only needs the file path
      if (operation === 'documentSymbol') {
        const results = await lspService.documentSymbol(absolutePath)
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No results found' }]
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
        }
      }

      // Remaining operations require line and character
      if (line === undefined || character === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `Operation "${operation}" requires line and character parameters`
            }
          ],
          isError: true
        }
      }

      // Convert 1-based (user-facing) to 0-based (LSP protocol)
      const pos: LspPosition = {
        file: absolutePath,
        line: line - 1,
        character: character - 1
      }

      let results: unknown[]

      switch (operation) {
        case 'goToDefinition':
          results = await lspService.goToDefinition(pos)
          break
        case 'hover':
          results = await lspService.hover(pos)
          break
        case 'findReferences':
          results = await lspService.findReferences(pos)
          break
        case 'goToImplementation':
          results = await lspService.goToImplementation(pos)
          break
        case 'incomingCalls':
          results = await lspService.incomingCalls(pos)
          break
        case 'outgoingCalls':
          results = await lspService.outgoingCalls(pos)
          break
        default:
          return {
            content: [
              { type: 'text', text: `Unknown operation: ${operation}` }
            ],
            isError: true
          }
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No results found' }]
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `LSP error: ${message}` }],
        isError: true
      }
    }
  }
}

/**
 * Create an MCP server config that exposes the LSP tool to the Claude Agent SDK.
 * Dynamically imports the SDK since it's ESM-only.
 */
export async function createLspMcpServerConfig(lspService: LspService) {
  const { createSdkMcpServer, tool } = await import(
    '@anthropic-ai/claude-agent-sdk'
  )
  const { z } = await import('zod')

  const handler = createLspToolHandler(lspService)

  const lspTool = tool(
    'lsp',
    LSP_TOOL_DESCRIPTION,
    {
      operation: z.enum(LSP_OPERATIONS as unknown as [string, ...string[]]),
      filePath: z
        .string()
        .describe('Absolute or project-relative path to the file'),
      line: z
        .number()
        .optional()
        .describe('1-based line number'),
      character: z
        .number()
        .optional()
        .describe('1-based character position')
    },
    async (args) => handler(args as LspToolArgs),
    { annotations: { readOnly: true } }
  )

  return createSdkMcpServer({
    name: 'hive-lsp',
    version: '1.0.0',
    tools: [lspTool]
  })
}
