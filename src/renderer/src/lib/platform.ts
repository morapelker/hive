let _platform: string | null = null

export async function initPlatform(): Promise<void> {
  try {
    _platform = await window.systemOps.getPlatform()
  } catch {
    // Fallback: detect from navigator as best-effort
    const nav = navigator.platform.toLowerCase()
    _platform = nav.includes('win') ? 'win32' : nav.includes('linux') ? 'linux' : 'darwin'
  }
}

export const isMac = (): boolean => _platform === 'darwin'
export const isWindows = (): boolean => _platform === 'win32'

export const revealLabel = (isDir: boolean): string =>
  isMac()
    ? isDir
      ? 'Open in Finder'
      : 'Reveal in Finder'
    : isDir
      ? 'Open in Explorer'
      : 'Show in Explorer'

export const fileManagerName = (): string => (isMac() ? 'Finder' : 'Explorer')
