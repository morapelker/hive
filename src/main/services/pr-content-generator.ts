import { generateText } from './text-generation-router'
import { createLogger } from './logger'
import type { AgentSdkId } from './agent-sdk-types'

const log = createLogger({ component: 'PRContentGenerator' })

const MAX_COMMIT_SUMMARY_LENGTH = 12 * 1024
const MAX_DIFF_SUMMARY_LENGTH = 12 * 1024
const MAX_DIFF_PATCH_LENGTH = 40 * 1024
const MAX_TITLE_LENGTH = 256

const SYSTEM_PROMPT = `You write GitHub pull request content.
Return a JSON object with keys: title, body.
Rules:
- title should be concise and specific
- body must be markdown with headings '## Summary' and '## Testing'
- under Summary, provide short bullet points
- under Testing, include bullet points with concrete checks or 'Not run'`

export const PR_CONTENT_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' }
  },
  required: ['title', 'body'],
  additionalProperties: false
})

export interface GeneratePRContentOptions {
  baseBranch: string
  headBranch: string
  commitSummary: string
  diffSummary: string
  diffPatch: string
  provider: AgentSdkId
}

export interface PRContent {
  title: string
  body: string
}

/**
 * Generate a PR title and body using an LLM provider.
 *
 * Constructs a prompt from the branch names, commit summary, diff stat,
 * and diff patch, then calls the text generation router.
 * The LLM response is parsed as JSON with { title, body }.
 *
 * Returns null if generation fails or the response cannot be parsed.
 */
export async function generatePRContent(options: GeneratePRContentOptions): Promise<PRContent> {
  const { baseBranch, headBranch, commitSummary, diffSummary, diffPatch, provider } = options

  const truncatedCommitSummary = truncate(commitSummary, MAX_COMMIT_SUMMARY_LENGTH)
  const truncatedDiffSummary = truncate(diffSummary, MAX_DIFF_SUMMARY_LENGTH)
  const truncatedDiffPatch = truncate(diffPatch, MAX_DIFF_PATCH_LENGTH)

  const prompt = `Base branch: ${baseBranch}
Head branch: ${headBranch}

Commits:
${truncatedCommitSummary}

Diff stat:
${truncatedDiffSummary}

Diff patch:
${truncatedDiffPatch}`

  log.info('Generating PR content', { baseBranch, headBranch, provider })

  const response = await generateText(
    prompt,
    SYSTEM_PROMPT,
    provider,
    undefined,
    PR_CONTENT_JSON_SCHEMA
  )
  if (!response) {
    throw new Error('AI provider returned an empty response')
  }

  return parsePRContent(response)
}

/**
 * Parse the LLM response as JSON and extract { title, body }.
 * Handles responses where the JSON may be wrapped in markdown code fences.
 */
function parsePRContent(response: string): PRContent {
  const json = extractJSON(response)
  if (!json) {
    log.warn('Could not extract JSON from response', {
      responsePrefix: response.slice(0, 200),
      responseLength: response.length
    })
    throw new Error('Could not extract JSON from AI response')
  }

  const parsed = JSON.parse(json) as Record<string, unknown>

  if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
    log.warn('Parsed JSON missing title or body fields')
    throw new Error('AI response missing required title or body fields')
  }

  const title = sanitizeTitle(parsed.title)
  const body = parsed.body

  return { title, body }
}

/**
 * Extract a JSON object string from the response.
 * Handles raw JSON, or JSON wrapped in markdown code fences (```json ... ```).
 */
function extractJSON(text: string): string | null {
  // Try stripping markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) {
    return fenceMatch[1].trim()
  }

  // Try finding a raw JSON object
  const braceStart = text.indexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1)
  }

  return null
}

/**
 * Sanitize the title: collapse to a single line and enforce max length.
 */
function sanitizeTitle(title: string): string {
  // Collapse to single line
  const singleLine = title.replace(/[\r\n]+/g, ' ').trim()

  if (singleLine.length > MAX_TITLE_LENGTH) {
    return singleLine.slice(0, MAX_TITLE_LENGTH - 3) + '...'
  }

  return singleLine
}

/**
 * Truncate a string to the given character-approximate length.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '\n... (truncated)'
}
