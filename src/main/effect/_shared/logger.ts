import { Cause, Effect, HashMap, Layer, Logger, Option } from 'effect'
import type * as EffectHashMap from 'effect/HashMap'

import { LoggerService, LogLevel } from '../../services/logger'

const COMPONENT_ANNOTATION = 'component'
const DEFAULT_COMPONENT = 'EffectIsland'

const toLogLevel = (label: string): LogLevel => {
  switch (label) {
    case 'TRACE':
    case 'DEBUG':
      return LogLevel.DEBUG
    case 'INFO':
      return LogLevel.INFO
    case 'WARN':
      return LogLevel.WARN
    case 'FATAL':
    case 'ERROR':
      return LogLevel.ERROR
    default:
      return LogLevel.INFO
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !(value instanceof Error) && !Array.isArray(value)

const stringifyMessagePart = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  return String(value)
}

const splitMessage = (
  message: unknown
): {
  readonly text: string
  readonly data: Record<string, unknown>
  readonly error?: Error
} => {
  const parts = Array.isArray(message) ? message : [message]
  const textParts: string[] = []
  const data: Record<string, unknown> = {}
  let error: Error | undefined

  for (const part of parts) {
    if (part instanceof Error) {
      error ??= part
    } else if (isRecord(part)) {
      Object.assign(data, part)
    } else {
      textParts.push(stringifyMessagePart(part))
    }
  }

  return { text: textParts.join(' '), data, error }
}

const annotationData = (
  annotations: EffectHashMap.HashMap<string, unknown>
): {
  readonly component: string
  readonly data: Record<string, unknown>
} => {
  const data: Record<string, unknown> = {}
  let component = DEFAULT_COMPONENT

  for (const [key, value] of HashMap.toEntries(annotations)) {
    if (key === COMPONENT_ANNOTATION) {
      if (typeof value === 'string' && value.length > 0) component = value
    } else {
      data[key] = value
    }
  }

  return { component, data }
}

const hiveLogger = Logger.make<unknown, void>((options) => {
  const service = LoggerService.getInstance()
  const level = toLogLevel(options.logLevel.label)
  const message = splitMessage(options.message)
  const annotations = annotationData(options.annotations)
  const data = { ...annotations.data, ...message.data }
  const payload = Object.keys(data).length > 0 ? data : undefined

  if (level === LogLevel.ERROR) {
    const failure = Cause.failureOption(options.cause)
    const failureValue = Option.isSome(failure) ? failure.value : undefined
    const error = message.error ?? (failureValue instanceof Error ? failureValue : undefined)

    if (error) {
      service.error(annotations.component, message.text, error, payload)
    } else if (failureValue !== undefined) {
      service.error(annotations.component, message.text, undefined, {
        ...data,
        cause: String(failureValue)
      })
    } else {
      service.error(annotations.component, message.text, undefined, payload)
    }
    return
  }

  if (level === LogLevel.WARN) {
    service.warn(annotations.component, message.text, payload)
    return
  }

  if (level === LogLevel.DEBUG) {
    service.debug(annotations.component, message.text, payload)
    return
  }

  service.info(annotations.component, message.text, payload)
})

export const LoggerLive: Layer.Layer<never> = Logger.replace(Logger.defaultLogger, hiveLogger)

export const withLogComponent = (component: string) => Effect.annotateLogs({ component })
