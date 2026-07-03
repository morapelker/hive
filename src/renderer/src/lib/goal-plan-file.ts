import { fileApi } from '@/api/file-api'

/**
 * Goal prompts (`/goal ...`) longer than this get rejected by the CLI, so
 * oversized ticket prompts are written to a PLAN_{uuid}.md file and the goal
 * prompt is slimmed down to "Implement PLAN_{uuid}.md" instead.
 */
export const GOAL_PROMPT_MAX_LENGTH = 3000

export function exceedsGoalPromptLimit(prompt: string | null | undefined): boolean {
  return !!prompt && prompt.length > GOAL_PROMPT_MAX_LENGTH
}

/** The prompt body that replaces the full ticket description in the goal prompt. */
export function planFilePrompt(fileName: string): string {
  return `Implement ${fileName}`
}

/**
 * Write the full ticket prompt to a PLAN_{uuid}.md in the session root
 * (worktree or connection path) so the agent can read it from disk.
 * Returns the created file name; throws when the write fails.
 */
export async function createPlanFile(rootPath: string, content: string): Promise<string> {
  const fileName = `PLAN_${crypto.randomUUID()}.md`
  const result = await fileApi.createFile(rootPath, fileName, content, false)
  if (!result.success) {
    throw new Error(`Failed to create plan file: ${result.error ?? 'Unknown error'}`)
  }
  return fileName
}
