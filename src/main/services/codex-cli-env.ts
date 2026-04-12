import { getDatabase } from '../db'
import { getUserEnvironmentVariables } from './env-vars'

export function getCodexCliEnv(options?: {
  codexHomePath?: string
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...getUserEnvironmentVariables(getDatabase()),
    ...(options?.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {})
  }
}
