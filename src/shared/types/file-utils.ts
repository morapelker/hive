export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp'
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  if (lastDot === -1 || lastDot === filePath.length - 1) return ''
  return filePath.slice(lastDot).toLowerCase()
}

export function isImageFile(filePath: string): boolean {
  return getExtension(filePath) in IMAGE_MIME_TYPES
}

export function isSvgFile(filePath: string): boolean {
  return getExtension(filePath) === '.svg'
}

export function isBinaryImageFile(filePath: string): boolean {
  return isImageFile(filePath) && !isSvgFile(filePath)
}

export function getImageMimeType(filePath: string): string | null {
  const ext = getExtension(filePath)
  return IMAGE_MIME_TYPES[ext] ?? null
}
