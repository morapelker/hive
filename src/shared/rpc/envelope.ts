import type { Envelope } from '@shared/types/ipc-envelope'
import type { RpcResponse } from './protocol'

export const rpcResponseToEnvelope = <A>(response: RpcResponse): Envelope<A> => {
  if (response.ok) {
    return { success: true, value: response.value as A }
  }

  return {
    success: false,
    errorCode: response.error.code,
    error: response.error.message,
    ...(response.error.details === undefined ? {} : { details: response.error.details })
  }
}

