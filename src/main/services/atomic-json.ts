import { mkdir, chmod, rename, readFile, writeFile } from 'fs/promises'
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
  await writeFile(tmpPath, serialized, 'utf-8')
  await chmod(tmpPath, opts?.mode ?? 0o600)
  await rename(tmpPath, path)
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
