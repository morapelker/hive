import { z } from 'zod'

export const SdkMessageSchema = z
  .object({
    type: z.string().min(1),
    session_id: z.string().optional()
  })
  .passthrough()

export type ClaudeSdkMessage = z.infer<typeof SdkMessageSchema>
