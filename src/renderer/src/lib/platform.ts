// Synchronous best-guess so callers before initPlatform() get a reasonable default
const nav = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : ''
let _platform: string = nav.includes('win') ? 'win32' : nav.includes('linux') ? 'linux' : 'darwin'

export async function initPlatform(): Promise<void> {
  try {
    _platform = await window.systemOps.getPlatform()
  } catch {
    // Keep the synchronous best-guess already set above
  }
}

export const isMac = (): boolean => _platform === 'darwin'
export const isWindows = (): boolean => _platform === 'win32'
export const isLinux = (): boolean => _platform === 'linux'

export const revealLabel = (isDir: boolean): string =>
  isMac()
    ? isDir
      ? 'Open in Finder'
      : 'Reveal in Finder'
    : isLinux()
      ? isDir
        ? 'Open in File Manager'
        : 'Show in File Manager'
      : isDir
        ? 'Open in Explorer'
        : 'Show in Explorer'

export const fileManagerName = (): string =>
  isMac() ? 'Finder' : isLinux() ? 'File Manager' : 'Explorer'
