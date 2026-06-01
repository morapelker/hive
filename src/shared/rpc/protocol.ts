import { z } from 'zod'

export const RpcRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional()
})

export type RpcRequest = z.infer<typeof RpcRequestSchema>

export const RpcErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
})

export type RpcError = z.infer<typeof RpcErrorSchema>

export type RpcResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: RpcError }

export const SubscriptionRequestSchema = z
  .object({
    channel: z.string().min(1),
    filter: z.unknown().optional()
  })
  .strict()

export type SubscriptionRequest = z.infer<typeof SubscriptionRequestSchema>

export const WebSocketSubscribeMessageSchema = SubscriptionRequestSchema.extend({
  type: z.literal('subscribe')
}).strict()

export type WebSocketSubscribeMessage = z.infer<typeof WebSocketSubscribeMessageSchema>

export const WebSocketUnsubscribeMessageSchema = z
  .object({
    type: z.literal('unsubscribe'),
    channel: z.string().min(1)
  })
  .strict()

export type WebSocketUnsubscribeMessage = z.infer<typeof WebSocketUnsubscribeMessageSchema>

export interface ServerEvent {
  readonly channel: string
  readonly payload: unknown
}
