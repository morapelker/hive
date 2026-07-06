import { mkdir, chmod, rename, readFile, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'

/**
 * Write JSON to disk atomically: serialize, validate, write to a sibling
 * `.tmp.hive` file, chmod it, then rename over the destination. The rename
 * is atomic on POSIX filesystems, so readers never observe a partial write.
 * Creates the parent directory (recursively) if it doesn't exist yet.
 */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { mode?: number; pretty?: boolean }
): Promise<void> {
  const serialized = opts?.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  JSON.parse(serialized)

  await mkdir(dirname(path), { recursive: true })

  const tmpPath = `${path}.tmp.hive`
  const mode = opts?.mode ?? 0o600
  try {
    // Create the tmp file with the restrictive mode from the start — passing it
    // to writeFile avoids the brief 0644 window that a create-then-chmod would
    // open on a secrets file. The explicit chmod stays for exactness (writeFile
    // honors the process umask, which could clear bits the caller asked for).
    await writeFile(tmpPath, serialized, { encoding: 'utf-8', mode })
    await chmod(tmpPath, mode)
    await rename(tmpPath, path)
  } catch (error) {
    // Best-effort: don't leave a (potentially world-readable) partial secrets
    // file behind if the chmod/rename failed.
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Read and parse a JSON file. Returns null when the file is missing or its
 * contents fail to parse.
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
