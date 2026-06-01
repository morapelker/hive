import { exec as execChildProcess } from 'child_process'

export interface OpenInChromeResult {
  readonly success: boolean
  readonly error?: string
}

interface OpenInChromeDeps {
  readonly openExternal?: (url: string) => Promise<void>
  readonly exec?: (command: string, callback: (error: Error | null) => void) => void
}

export const openInChrome = async (
  url: string,
  customCommand?: string,
  deps: OpenInChromeDeps = {}
): Promise<OpenInChromeResult> => {
  try {
    if (customCommand) {
      const command = customCommand.includes('{url}')
        ? customCommand.replace(/\{url\}/g, url)
        : `${customCommand} ${url}`

      await new Promise<void>((resolve, reject) => {
        ;(deps.exec ?? execChildProcess)(command, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    } else {
      if (!deps.openExternal) {
        return { success: false, error: 'No external URL opener is available' }
      }
      await deps.openExternal(url)
    }

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
