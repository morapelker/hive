import {
  GitDirty,
  GitMergeConflict,
  GitNetworkError,
  GitNotARepository,
  GitPermissionDenied,
  GitUnknown,
  type GitError
} from './errors'

type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'apply'

type ClassifierContext = {
  readonly worktreePath: string
  readonly command: string
  readonly operation?: GitOperation
}

const excerpt = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 500)
}

const errorText = (err: unknown): string => {
  const parts: string[] = []
  if (err instanceof Error) parts.push(err.message)
  else parts.push(String(err))

  const record = err as {
    message?: unknown
    stack?: unknown
    stdout?: unknown
    stderr?: unknown
    git?: { message?: unknown; stderr?: unknown }
  }
  if (typeof record.message === 'string') parts.push(record.message)
  if (typeof record.stderr === 'string') parts.push(record.stderr)
  if (typeof record.stdout === 'string') parts.push(record.stdout)
  if (typeof record.git?.message === 'string') parts.push(record.git.message)
  if (typeof record.git?.stderr === 'string') parts.push(record.git.stderr)
  return parts.join('\n').toLowerCase()
}

const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : undefined
}

const includesAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((needle) => text.includes(needle.toLowerCase()))

const conflictList = (err: unknown): readonly string[] => {
  const conflicts = (err as { git?: { conflicts?: unknown } })?.git?.conflicts
  return Array.isArray(conflicts) ? conflicts.filter((item): item is string => typeof item === 'string') : []
}

const parseAffectedPaths = (message: string): readonly string[] | undefined => {
  const lines = message.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    /(?:following files|overwrite the following files)/i.test(line)
  )
  if (start === -1) return undefined

  const paths: string[] = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (!line) continue
    if (/^(please|aborting|error:|fatal:)/i.test(line)) break
    paths.push(line)
  }
  return paths.length > 0 ? paths : undefined
}

export function classifyGitError(err: unknown, ctx: ClassifierContext): GitError {
  const stderrExcerpt = excerpt(err)
  const text = errorText(err)
  const code = codeOf(err)
  const base = {
    worktreePath: ctx.worktreePath,
    command: ctx.command,
    stderrExcerpt,
    cause: err
  }

  const conflicts = conflictList(err)
  if (
    (ctx.operation === 'apply' && includesAny(text, ['patch', 'apply'])) ||
    conflicts.length > 0 ||
    includesAny(text, [
      'merge conflict',
      'conflict (content)',
      'conflict (rename',
      'automatic merge failed',
      'could not apply',
      'after resolving the conflicts',
      'hunk #'
    ])
  ) {
    return new GitMergeConflict({
      ...base,
      operation: ctx.operation ?? 'merge',
      conflicts
    })
  }

  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    includesAny(text, [
      'authentication failed',
      'permission denied (publickey)',
      'permission denied',
      '403 forbidden',
      'could not read username',
      'terminal prompts disabled'
    ])
  ) {
    return new GitPermissionDenied(base)
  }

  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    includesAny(text, [
      'could not read from remote repository',
      'could not resolve host',
      'connection timed out',
      'the remote end hung up',
      'unable to access',
      'failed to connect'
    ])
  ) {
    return new GitNetworkError(base)
  }

  if (
    includesAny(text, [
      'uncommitted changes',
      'would be overwritten by checkout',
      'would be overwritten by merge',
      'please commit your changes or stash them',
      'your local changes to the following files',
      'untracked working tree files would be overwritten'
    ])
  ) {
    return new GitDirty({
      ...base,
      affectedPaths: parseAffectedPaths(stderrExcerpt)
    })
  }

  if (
    includesAny(text, [
      'not a git repository',
      'fatal: not in a git directory',
      'is outside repository at'
    ])
  ) {
    return new GitNotARepository(base)
  }

  return new GitUnknown(base)
}
