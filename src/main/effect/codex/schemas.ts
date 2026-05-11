import { z } from 'zod'

export const CodexEventSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    method: z.string().min(1),
    threadId: z.string().min(1),
    payload: z.unknown().optional(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    textDelta: z.string().optional(),
    message: z.string().optional()
  })
  .passthrough()

export type CodexSdkEvent = z.infer<typeof CodexEventSchema>
