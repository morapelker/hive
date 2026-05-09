import { z } from 'zod'

const EventPropertiesSchema = z.record(z.string(), z.unknown())

export const DirectSdkEventSchema = z
  .object({
    type: z.string().min(1),
    properties: EventPropertiesSchema.optional()
  })
  .passthrough()

export const GlobalSdkEventSchema = z
  .object({
    directory: z.string().min(1),
    payload: DirectSdkEventSchema
  })
  .passthrough()

export const SdkEventSchema = z.union([DirectSdkEventSchema, GlobalSdkEventSchema])

export const SessionCreateResponseSchema = z
  .object({
    data: z.object({ id: z.string().min(1) }).passthrough()
  })
  .passthrough()

export type OpenCodeSdkEvent = z.infer<typeof SdkEventSchema>
export type DirectOpenCodeSdkEvent = z.infer<typeof DirectSdkEventSchema>
