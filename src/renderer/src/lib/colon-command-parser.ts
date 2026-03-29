import { COLON_COMMANDS } from '@/stores/useFilterStore'

export interface ParsedInput {
  type: 'text' | 'command-search' | 'value-search'
  commandFilter?: string
  command?: string
  valueFilter?: string
}

export function parseFilterInput(input: string): ParsedInput {
  if (!input.startsWith(':')) return { type: 'text' }

  const eqIndex = input.indexOf('=')

  if (eqIndex === -1) {
    return { type: 'command-search', commandFilter: input.slice(1) }
  }

  const commandName = input.slice(1, eqIndex)
  const matched = COLON_COMMANDS.find(
    (c) => c.name.toLowerCase() === commandName.toLowerCase()
  )

  if (!matched) return { type: 'text' }

  return {
    type: 'value-search',
    command: matched.name,
    valueFilter: input.slice(eqIndex + 1)
  }
}
