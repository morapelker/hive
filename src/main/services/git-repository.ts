import { execSync } from 'child_process'
import { createLogger } from './logger'

const log = createLogger({ component: 'GitRepository' })

export interface InitRepositoryResult {
  readonly success: boolean
  readonly error?: string
}

/**
 * Initialize a new git repository with main as the default branch.
 */
export function initRepository(path: string): InitRepositoryResult {
  try {
    log.info('Initializing git repository', { path })
    execSync('git init --initial-branch=main', { cwd: path, encoding: 'utf-8' })
    log.info('Git repository initialized successfully', { path })
    return { success: true }
  } catch (error) {
    log.error(
      'Failed to initialize git repository',
      error instanceof Error ? error : new Error(String(error)),
      { path }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
