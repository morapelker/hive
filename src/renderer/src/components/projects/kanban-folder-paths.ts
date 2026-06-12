const normalizeSelectedFolderPath = (path: string): string => {
  let normalized = path.replace(/\\/g, '/')
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

export function formatSelectedKanbanFolder(projectPath: string, selectedPath: string): string {
  const normalizedProjectPath = normalizeSelectedFolderPath(projectPath)
  const normalizedSelectedPath = normalizeSelectedFolderPath(selectedPath)

  if (normalizedSelectedPath === normalizedProjectPath) {
    return '.'
  }

  const projectPrefix = normalizedProjectPath.endsWith('/')
    ? normalizedProjectPath
    : `${normalizedProjectPath}/`

  if (normalizedSelectedPath.startsWith(projectPrefix)) {
    return normalizedSelectedPath.slice(projectPrefix.length)
  }

  return normalizedSelectedPath
}
