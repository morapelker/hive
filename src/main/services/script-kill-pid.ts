export interface KillPidResult {
  readonly killed: boolean
  readonly reason?: string
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    return error.code === 'EPERM'
  }
}

export const killPid = async (pid: number): Promise<KillPidResult> => {
  if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) {
    return { killed: false, reason: 'EINVAL' }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    return { killed: false, reason: error.code ?? String(err) }
  }

  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!isAlive(pid)) return { killed: true }
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    return { killed: false, reason: error.code ?? String(err) }
  }

  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!isAlive(pid)) return { killed: true }
  }

  return { killed: false, reason: 'still alive after SIGKILL' }
}
