// After "Move projects" a project sits in another folder, and the window still holds things
// by their old absolute path: the keys of the file tree's maps, the expanded folders in them,
// the open file tabs. These helpers are the one place that says what "inside a moved folder"
// means and where such a path is now. Pure, no imports, so the file-tree store can use them
// without pulling in the stores the refresh after a move reloads.

/** One folder whose path changed, in the spellings the database held before and holds now. */
export interface MovedPath {
  from: string
  to: string
}

// A POSIX path splits at '/' only: a backslash is an ordinary character in a name there. A
// Windows path (a drive letter or a UNC share) splits at either.
const separatorsOf = (folder: string): string => (folder.startsWith('/') ? '/' : '\\/')

const withoutTrailingSeparators = (folder: string): string => {
  const separators = separatorsOf(folder)
  let end = folder.length
  while (end > 0 && separators.includes(folder[end - 1])) end--
  return folder.slice(0, end)
}

/**
 * True when `path` is `folder` itself or something inside it. The match has to end at a
 * separator: `/x/app2` and `/x/app-feature` are not inside `/x/app`. A filesystem root holds
 * every path and is never a moved folder, so it matches nothing.
 */
export const isSameOrInsidePath = (path: string, folder: string): boolean => {
  const base = withoutTrailingSeparators(folder)
  if (base.length === 0) return false
  if (path === base) return true
  return (
    path.length > base.length &&
    path.startsWith(base) &&
    separatorsOf(base).includes(path[base.length])
  )
}

/**
 * The folder that holds `path`, without a trailing separator, or '' when `path` names nothing
 * inside a folder (a root, a bare name). Two folders with the same answer sit next to each
 * other: a worktree next to its project's checkout moves to the dev folder with it.
 */
export const parentFolderOf = (path: string): string => {
  const base = withoutTrailingSeparators(path)
  const separators = separatorsOf(base)
  let end = base.length
  while (end > 0 && !separators.includes(base[end - 1])) end--
  return withoutTrailingSeparators(base.slice(0, end))
}

/**
 * Where `path` is after `moves`, or null when no moved folder is `path` or holds it. When
 * two moved folders hold it (a project and a worktree inside that project), the deeper one
 * decides.
 */
export const movedPathFor = (path: string, moves: readonly MovedPath[]): string | null => {
  let from: string | null = null
  let to = ''
  for (const move of moves) {
    if (!isSameOrInsidePath(path, move.from)) continue
    const base = withoutTrailingSeparators(move.from)
    if (from !== null && base.length <= from.length) continue
    from = base
    to = withoutTrailingSeparators(move.to)
  }
  return from === null ? null : to + path.slice(from.length)
}
