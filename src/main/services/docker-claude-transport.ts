import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import {
  createSandboxSpawner,
  type SandboxAgent
} from './docker-sandbox-service.ts'
import { createLogger } from './logger.ts'

const log = createLogger({ component: 'DockerClaudeTransport' })

export interface DockerClaudeTransportOptions {
  enabled: boolean
  sandboxName: string
  worktreePath: string
  projectGitPath: string
  token?: string | null
  agent?: SandboxAgent
  claudeBinaryPath?: string | null
  env?: NodeJS.ProcessEnv
}

export interface ClaudeCliTransportConfig {
  env: NodeJS.ProcessEnv
  pathToClaudeCodeExecutable?: string
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess
  usesDockerWrapper: boolean
}

export function resolveClaudeCliTransport(
  options: DockerClaudeTransportOptions
): ClaudeCliTransportConfig {
  const env = { ...(options.env ?? process.env) } as NodeJS.ProcessEnv

  if (options.enabled && options.token) {
    const agent = options.agent ?? 'claude'
    env.HIVE_DOCKER_SANDBOX_ENABLED = '1'
    env.HIVE_DOCKER_SANDBOX_NAME = options.sandboxName
    env.HIVE_DOCKER_SANDBOX_WORKTREE = options.worktreePath
    env.HIVE_DOCKER_SANDBOX_PROJECT_GIT = options.projectGitPath
    env.HIVE_DOCKER_SANDBOX_AGENT = agent
    env.CLAUDE_CODE_OAUTH_TOKEN = options.token

    log.info('Configured Docker sandbox Claude transport', {
      sandboxName: options.sandboxName,
      mode: 'spawnClaudeCodeProcess',
      execPrefix: `docker sandbox exec -e CLAUDE_CODE_OAUTH_TOKEN=<redacted> ${options.sandboxName} claude --print`
    })

    return {
      env,
      pathToClaudeCodeExecutable: options.claudeBinaryPath ?? undefined,
      spawnClaudeCodeProcess: createSandboxSpawner({
        sandboxName: options.sandboxName,
        worktreePath: options.worktreePath,
        projectGitPath: options.projectGitPath,
        token: options.token ?? undefined,
        agent
      }),
      usesDockerWrapper: false
    }
  }

  return {
    env,
    pathToClaudeCodeExecutable: options.claudeBinaryPath ?? undefined,
    usesDockerWrapper: false
  }
}
