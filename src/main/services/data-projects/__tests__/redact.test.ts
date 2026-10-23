import { describe, expect, it } from 'vitest'
import { RpcRouteError, toRpcError } from '../../../../shared/rpc/errors'
import { binaryCell, toCell } from '../cells'
import {
  credentialsRequiredError,
  errorMessage,
  isDataEngineError,
  redactSecrets,
  redactUrlCredentials
} from '../redact'

describe('redactSecrets', () => {
  it('masks known secrets (raw and URL-encoded), longest first', () => {
    expect(redactSecrets("Access denied (password 'p@ss w0rd!')", ['p@ss w0rd!'])).toBe(
      "Access denied (password '***')"
    )
    expect(redactSecrets('dsn ...p%40ss%20w0rd!...', ['p@ss w0rd!'])).toBe('dsn ...***...')
    expect(redactSecrets('abcdefgh', ['abcd', 'abcdefgh'])).toBe('***')
  })

  it('masks short secrets only as whole tokens', () => {
    expect(redactSecrets("password 'ab' was wrong; table abc", ['ab'])).toBe(
      "password '***' was wrong; table abc"
    )
  })

  it('masks URL userinfo and key=value secrets but keeps "using password: YES"', () => {
    expect(redactUrlCredentials('postgres://u:pw@db:5432/x')).toBe('postgres://u:***@db:5432/x')
    expect(redactSecrets('mysql://root:p@ss@host/db failed')).toBe(
      'mysql://root:***@host/db failed'
    )
    expect(redactSecrets('host=db password=hunter2 sslmode=require')).toBe(
      'host=db password=*** sslmode=require'
    )
    expect(redactSecrets('{"password":"hunter2"}')).toBe('{"password":"***"}')
    expect(redactSecrets("Access denied for user 'root'@'x' (using password: YES)")).toBe(
      "Access denied for user 'root'@'x' (using password: YES)"
    )
  })

  it('URL masking stays linear on long words (a blob echoed in an error)', () => {
    const blob = 'A'.repeat(400_000)
    const started = Date.now()
    expect(redactSecrets(`near '${blob}' jdbc:mysql://u:pw@h/x`)).toBe(
      `near '${blob}' jdbc:mysql://u:***@h/x`
    )
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('errorMessage unwraps AggregateError and redacts', () => {
    const agg = new AggregateError([new Error('connect ECONNREFUSED ::1:5432 secretpw')], '')
    expect(errorMessage(agg, (t) => redactSecrets(t, ['secretpw']))).toBe(
      'connect ECONNREFUSED ::1:5432 ***'
    )
    expect(errorMessage(null)).toBe('Unknown error')
  })

  it('DataEngineError is an RpcRouteError whose code survives toRpcError', () => {
    const err = credentialsRequiredError('need it')
    expect(err).toBeInstanceOf(RpcRouteError)
    expect(err.name).toBe('DATA_CREDENTIALS_REQUIRED')
    expect(toRpcError(err)).toEqual({ code: 'DATA_CREDENTIALS_REQUIRED', message: 'need it' })
    expect(isDataEngineError(new RpcRouteError('DATA_NOT_FOUND', 'x'))).toBe(true)
    expect(isDataEngineError(new Error('x'))).toBe(false)
  })
})

describe('cells', () => {
  it('converts driver values to exact, JSON-safe cells', () => {
    expect(toCell(12345678901234567890n)).toBe('12345678901234567890')
    expect(toCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(toCell(Number.NaN)).toBe('NaN')
    expect(toCell(undefined)).toBe(null)
    expect(toCell({ a: 1n, b: Buffer.from([1]) })).toBe('{"a":"1","b":"\\\\x01"}')
    const big = Buffer.alloc(100, 0xab)
    expect(toCell(big)).toEqual({ $t: 'bin', hex: 'ab'.repeat(64), len: 100 })
    expect(toCell(big, { binaryPreviewBytes: Infinity })).toEqual(binaryCell(big, Infinity))
    expect(JSON.stringify(toCell({ self: null }))).toBeTruthy()
  })
})
