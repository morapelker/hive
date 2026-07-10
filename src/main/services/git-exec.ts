import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Minimal `git <args>` runner shared by services that need raw git plumbing
 * (as opposed to the higher-level `gitService` facade). Extracted from
 * `remote-project-ensure.ts`/`teleport-ops.ts`, which each used to keep a
 * private copy to avoid an import cycle — this module has no dependencies on
 * either, so both can import it instead of duplicating the implementation.
 */
export async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout.trim()
}
