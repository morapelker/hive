import { z } from 'zod'
import type { RpcError } from './protocol'

export const RPC_ERROR_CODES = {
  invalidRequest: 'INVALID_REQUEST',
  methodNotFound: 'METHOD_NOT_FOUND',
  validationFailed: 'VALIDATION_FAILED',
  internalError: 'INTERNAL_ERROR'
} as const

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES]

export class RpcRouteError extends Error {
  readonly code: RpcErrorCode | string
  readonly details?: unknown

  constructor(code: RpcErrorCode | string, message: string, details?: unknown) {
    super(message)
    this.name = 'RpcRouteError'
    this.code = code
    this.details = details
  }
}

export const toRpcError = (cause: unknown): RpcError => {
  if (cause instanceof RpcRouteError) {
    return {
      code: cause.code,
      message: cause.message,
      ...(cause.details === undefined ? {} : { details: cause.details })
    }
  }

  if (cause instanceof z.ZodError) {
    return {
      code: RPC_ERROR_CODES.validationFailed,
      message: 'RPC parameters failed validation',
      details: z.treeifyError(cause)
    }
  }

  if (cause instanceof Error) {
    return {
      code: RPC_ERROR_CODES.internalError,
      message: cause.message
    }
  }

  return {
    code: RPC_ERROR_CODES.internalError,
    message: 'Unexpected RPC failure',
    details: cause
  }
}

