import { graphqlQuery } from '../client'
import type { FileOpsApi } from '../../types'

export function createFileOpsAdapter(): FileOpsApi {
  return {
    // ─── Working via GraphQL ────────────────────────────────────
    async readFile(filePath: string): Promise<{
      success: boolean
      content?: string
      error?: string
    }> {
      const data = await graphqlQuery<{
        fileRead: { success: boolean; content?: string; error?: string }
      }>(
        `query ($filePath: String!) {
          fileRead(filePath: $filePath) { success content error }
        }`,
        { filePath }
      )
      return data.fileRead
    },

    async writeFile(
      filePath: string,
      content: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        fileWrite: { success: boolean; error?: string }
      }>(
        `mutation ($filePath: String!, $content: String!) {
          fileWrite(filePath: $filePath, content: $content) { success error }
        }`,
        { filePath, content }
      )
      return data.fileWrite
    },

    async readPrompt(promptName: string): Promise<{
      success: boolean
      content?: string
      error?: string
    }> {
      const data = await graphqlQuery<{
        fileReadPrompt: { success: boolean; content?: string; error?: string }
      }>(
        `query ($promptName: String!) {
          fileReadPrompt(promptName: $promptName) { success content error }
        }`,
        { promptName }
      )
      return data.fileReadPrompt
    },

    async readImageAsBase64(filePath: string): Promise<{
      success: boolean
      data?: string
      mimeType?: string
      error?: string
    }> {
      const result = await graphqlQuery<{
        fileReadImageAsBase64: {
          success: boolean
          content?: string
          mimeType?: string
          error?: string
        }
      }>(
        `query ($filePath: String!) {
          fileReadImageAsBase64(filePath: $filePath) { success content mimeType error }
        }`,
        { filePath }
      )
      return {
        success: result.fileReadImageAsBase64.success,
        data: result.fileReadImageAsBase64.content,
        mimeType: result.fileReadImageAsBase64.mimeType,
        error: result.fileReadImageAsBase64.error
      }
    },

    // ─── Browser alternative ────────────────────────────────────
    getPathForFile(file: File): string {
      return file.name
    }
  }
}
