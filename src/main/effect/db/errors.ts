import { Data } from 'effect'

export class DbConstraintViolation extends Data.TaggedError('DbConstraintViolation')<{
  readonly code: string
  readonly message: string
  readonly cause: unknown
}> {}

export class DbForeignKeyViolation extends Data.TaggedError('DbForeignKeyViolation')<{
  readonly code: string
  readonly message: string
  readonly cause: unknown
}> {}

export class DbBusy extends Data.TaggedError('DbBusy')<{
  readonly code: string
  readonly message: string
  readonly cause: unknown
}> {}

export class DbCorrupt extends Data.TaggedError('DbCorrupt')<{
  readonly code: string
  readonly message: string
  readonly cause: unknown
}> {}

export class DbUnknown extends Data.TaggedError('DbUnknown')<{
  readonly code: string
  readonly message: string
  readonly cause: unknown
}> {}

export type DbError =
  | DbConstraintViolation
  | DbForeignKeyViolation
  | DbBusy
  | DbCorrupt
  | DbUnknown

const readCode = (e: unknown): string => {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return ''
}

const readMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export const classifyDbError = (e: unknown): DbError => {
  const code = readCode(e)
  const message = readMessage(e)

  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(message)) {
    return new DbForeignKeyViolation({ code, message, cause: e })
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return new DbConstraintViolation({ code, message, cause: e })
  }
  if (code.startsWith('SQLITE_BUSY')) {
    return new DbBusy({ code, message, cause: e })
  }
  if (code.startsWith('SQLITE_CORRUPT')) {
    return new DbCorrupt({ code, message, cause: e })
  }
  return new DbUnknown({ code, message, cause: e })
}
