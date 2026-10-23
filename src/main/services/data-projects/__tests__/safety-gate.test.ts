import { describe, expect, it } from 'vitest'
import type {
  DataSafeMode,
  DataEnvironment,
  DataStatementClass
} from '../../../../shared/data-projects/types'
import type { SafetyEvaluationInput, SafetyStatementInput } from '../contracts'
import {
  createSafetyGate,
  extractTargetName,
  isDestructive,
  CONFIRM_TOKEN_TTL_MS
} from '../safety-gate'
import { makeRecord } from './engine-fixtures'

const stmt = (
  index: number,
  text: string,
  classification: DataStatementClass,
  dangerous: string[] = [],
  targets?: string[]
): SafetyStatementInput => ({
  index,
  text,
  start: 0,
  end: text.length,
  classification,
  dangerous,
  targets
})

const input = (
  safeMode: DataSafeMode,
  statements: SafetyStatementInput[],
  extra: Partial<SafetyEvaluationInput> & { environment?: DataEnvironment } = {}
): SafetyEvaluationInput => ({
  project: makeRecord({ safeMode, environment: extra.environment ?? 'development' }),
  database: 'shop',
  source: 'editor',
  statements,
  fingerprintText: statements.map((s) => s.text).join(';\n'),
  ...extra
})

const READ = stmt(0, 'SELECT * FROM users', 'read')
const USE = stmt(1, 'USE shop', 'session')
const WRITE = stmt(1, "UPDATE users SET name = 'x' WHERE id = 1", 'write')
const DROP = stmt(0, 'DROP TABLE orders', 'ddl', ['DROP TABLE'])
const DELETE_ALL = stmt(0, 'DELETE FROM orders', 'write', ['DELETE without WHERE'])

describe('safety gate: modes', () => {
  it('off: runs everything unsandboxed', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('off', [READ, WRITE]))
    expect(d).toEqual({ action: 'run', sandboxReads: [false, false] })
  })

  it('off: dangerous statements still confirm outside local', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('off', [DROP]))
    expect(d.action).toBe('confirm')
    if (d.action !== 'confirm') return
    expect(d.plan.statements[0].needsConfirmation).toBe(true)
    expect(d.plan.statements[0].dangerous).toEqual(['DROP TABLE'])
    expect(d.plan.typedConfirmation).toBeUndefined()
  })

  it('off + local: dangerous statements run without confirmation', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('off', [DROP], { environment: 'local' }))
    expect(d).toEqual({ action: 'run', sandboxReads: [false] })
  })

  it('half-safe: reads auto-run in the sandbox, session statements unsandboxed', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('half-safe', [READ, USE]))
    expect(d).toEqual({ action: 'run', sandboxReads: [true, false] })
  })

  it('half-safe: a write confirms the whole request', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('half-safe', [READ, WRITE]))
    expect(d.action).toBe('confirm')
    if (d.action !== 'confirm') return
    expect(d.plan.statements.map((s) => s.needsConfirmation)).toEqual([false, true])
    expect(d.plan.statements[1].reasons).toContain('modifies data')
    expect(d.plan.safeMode).toBe('half-safe')
    expect(d.plan.database).toBe('shop')
    expect(d.plan.projectName).toBe('Shop DB')
  })

  it("half-safe: shows the classifier's own reason instead of the class label", () => {
    const gate = createSafetyGate()
    const sleep = {
      ...stmt(0, 'SELECT pg_sleep(25)', 'write'),
      reasons: ['calls pg_sleep(), which has side effects']
    }
    const d = gate.evaluate(input('half-safe', [sleep]))
    expect(d.action).toBe('confirm')
    if (d.action !== 'confirm') return
    expect(d.plan.statements[0].reasons).toEqual(['calls pg_sleep(), which has side effects'])
    const ro = gate.evaluate(input('read-only', [sleep]))
    expect(ro.action).toBe('block')
    if (ro.action !== 'block') return
    expect(ro.reason).toMatch(/calls pg_sleep\(\)/)
  })

  it('half-safe: tx, lock, ddl, admin and unknown all confirm', () => {
    const gate = createSafetyGate()
    for (const cls of ['tx', 'lock', 'ddl', 'admin', 'unknown'] as const) {
      const d = gate.evaluate(input('half-safe', [stmt(0, 'X', cls)]))
      expect(d.action).toBe('confirm')
    }
  })

  it('half-safe: a dangerous read (pg_sleep) confirms', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(
      input('half-safe', [stmt(0, 'SELECT pg_sleep(10)', 'read', ['calls pg_sleep'])])
    )
    expect(d.action).toBe('confirm')
  })

  it('safe: everything confirms, even reads', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('safe', [READ]))
    expect(d.action).toBe('confirm')
    if (d.action !== 'confirm') return
    expect(d.plan.statements[0].reasons[0]).toMatch(/safe mode/)
  })

  it('read-only: reads run sandboxed, writes are blocked with a reason', () => {
    const gate = createSafetyGate()
    expect(gate.evaluate(input('read-only', [READ, USE]))).toEqual({
      action: 'run',
      sandboxReads: [true, false]
    })
    const d = gate.evaluate(input('read-only', [READ, WRITE]))
    expect(d.action).toBe('block')
    if (d.action !== 'block') return
    expect(d.reason).toMatch(/Read-only mode: statement 2 modifies data/)
    expect(d.plan.statements).toHaveLength(2)
  })

  it('read-only: a confirm token can never unlock a write', () => {
    const gate = createSafetyGate()
    const req = input('read-only', [WRITE], { confirmToken: 'whatever' })
    expect(gate.evaluate(req).action).toBe('block')
  })

  it('read-only: summarises several blocked statements', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(
      input('read-only', [stmt(0, 'INSERT', 'write'), stmt(1, 'CREATE', 'ddl')])
    )
    expect(d.action === 'block' && d.reason).toMatch(/2 statements/)
  })

  it('no statements: runs nothing', () => {
    const gate = createSafetyGate()
    expect(gate.evaluate(input('safe', []))).toEqual({ action: 'run', sandboxReads: [] })
  })
})

describe('safety gate: tokens', () => {
  it('a token runs exactly the confirmed request once, unsandboxed', () => {
    const gate = createSafetyGate()
    const req = input('half-safe', [READ, WRITE])
    const first = gate.evaluate(req)
    expect(first.action).toBe('confirm')
    if (first.action !== 'confirm') return
    const run = gate.evaluate({ ...req, confirmToken: first.confirmToken })
    expect(run).toEqual({ action: 'run', sandboxReads: [false, false] })
    // Single use.
    expect(gate.evaluate({ ...req, confirmToken: first.confirmToken }).action).toBe('confirm')
  })

  it('a token is bound to text, database, source and project', () => {
    const gate = createSafetyGate()
    const req = input('half-safe', [WRITE])
    const d = gate.evaluate(req)
    if (d.action !== 'confirm') throw new Error('expected confirm')
    const token = d.confirmToken
    expect(
      gate.evaluate({ ...req, confirmToken: token, fingerprintText: 'DROP TABLE users' }).action
    ).toBe('confirm')
    expect(gate.evaluate({ ...req, confirmToken: token, database: 'other' }).action).toBe('confirm')
    expect(gate.evaluate({ ...req, confirmToken: token, source: 'grid-edit' }).action).toBe(
      'confirm'
    )
    expect(
      gate.evaluate({
        ...req,
        project: makeRecord({ id: 'dp-2', safeMode: 'half-safe' }),
        confirmToken: token
      }).action
    ).toBe('confirm')
    // Mismatches did not burn the token: the original request still redeems it.
    expect(gate.evaluate({ ...req, confirmToken: token }).action).toBe('run')
  })

  it('tokens expire after 5 minutes', () => {
    let now = 1_000_000
    const gate = createSafetyGate({ now: () => now })
    const req = input('half-safe', [WRITE])
    const d = gate.evaluate(req)
    if (d.action !== 'confirm') throw new Error('expected confirm')
    now += CONFIRM_TOKEN_TTL_MS + 1
    expect(gate.evaluate({ ...req, confirmToken: d.confirmToken }).action).toBe('confirm')
  })

  it('read-only + token keeps reads in the sandbox', () => {
    const gate = createSafetyGate()
    const req = input('read-only', [stmt(0, 'SELECT SLEEP(5)', 'read', ['calls SLEEP'])])
    const d = gate.evaluate(req)
    if (d.action !== 'confirm') throw new Error('expected confirm')
    expect(gate.evaluate({ ...req, confirmToken: d.confirmToken })).toEqual({
      action: 'run',
      sandboxReads: [true]
    })
  })

  it('caps the number of live tokens', () => {
    let n = 0
    const gate = createSafetyGate({ maxTokens: 5, randomToken: () => `t${n++}` })
    for (let i = 0; i < 20; i++) gate.evaluate(input('safe', [stmt(0, `SELECT ${i}`, 'read')]))
    expect(gate.tokenCount()).toBeLessThanOrEqual(5)
  })
})

describe('safety gate: production typed confirmation', () => {
  it('asks for the table name on DROP TABLE', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(input('half-safe', [DROP], { environment: 'production' }))
    expect(d.action === 'confirm' && d.plan.typedConfirmation).toBe('orders')
  })

  it('prefers classifier targets and strips qualification/quotes', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(
      input(
        'off',
        [stmt(0, 'TRUNCATE `shop`.`order items`', 'write', ['TRUNCATE'], ['shop.order items'])],
        {
          environment: 'production'
        }
      )
    )
    expect(d.action === 'confirm' && d.plan.typedConfirmation).toBe('order items')
  })

  it('DELETE without WHERE on production → table name; dev → no typing', () => {
    const gate = createSafetyGate()
    const prod = gate.evaluate(input('half-safe', [DELETE_ALL], { environment: 'production' }))
    expect(prod.action === 'confirm' && prod.plan.typedConfirmation).toBe('orders')
    const dev = gate.evaluate(input('half-safe', [DELETE_ALL], { environment: 'staging' }))
    expect(dev.action === 'confirm' && dev.plan.typedConfirmation).toBeUndefined()
  })

  it('different targets → the database name', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(
      input('half-safe', [DROP, stmt(1, 'DROP TABLE users', 'ddl', ['DROP TABLE'])], {
        environment: 'production'
      })
    )
    expect(d.action === 'confirm' && d.plan.typedConfirmation).toBe('shop')
  })

  it('non-destructive dangerous statements do not need typing', () => {
    const gate = createSafetyGate()
    const d = gate.evaluate(
      input('half-safe', [stmt(0, 'KILL 12', 'admin', ['KILL'])], { environment: 'production' })
    )
    expect(d.action === 'confirm' && d.plan.typedConfirmation).toBeUndefined()
  })

  it('mongo deleteMany({}) → collection name; dropDatabase → database name', () => {
    const gate = createSafetyGate()
    const del = gate.evaluate(
      input(
        'half-safe',
        [stmt(0, 'db.orders.deleteMany({})', 'write', ['deleteMany({}) deletes every document'])],
        {
          environment: 'production'
        }
      )
    )
    expect(del.action === 'confirm' && del.plan.typedConfirmation).toBe('orders')
    const dropDb = gate.evaluate(
      input('half-safe', [stmt(0, 'db.dropDatabase()', 'ddl', ['dropDatabase'])], {
        environment: 'production'
      })
    )
    expect(dropDb.action === 'confirm' && dropDb.plan.typedConfirmation).toBe('shop')
  })
})

describe('safety gate: sandbox escalation and explicit blocks', () => {
  it('escalate → confirm with "tried to write" and a token that runs the request', () => {
    const gate = createSafetyGate()
    const req = input('half-safe', [READ, stmt(1, 'SELECT write_audit()', 'read')])
    const d = gate.escalate(req, 1)
    expect(d.action).toBe('confirm')
    if (d.action !== 'confirm') return
    expect(d.plan.statements[1].needsConfirmation).toBe(true)
    expect(d.plan.statements[1].reasons.join(' ')).toMatch(/tried to write/)
    expect(gate.evaluate({ ...req, confirmToken: d.confirmToken })).toEqual({
      action: 'run',
      sandboxReads: [false, false]
    })
  })

  it('escalate in read-only mode → block', () => {
    const gate = createSafetyGate()
    const d = gate.escalate(input('read-only', [READ]), 0)
    expect(d.action).toBe('block')
    expect(d.action === 'block' && d.reason).toMatch(/tried to write/)
  })

  it('block() marks only the given statements', () => {
    const gate = createSafetyGate()
    const d = gate.block(input('off', [READ, WRITE]), 'Only reads can be exported', [1])
    expect(d.plan.statements[1].reasons).toContain('Only reads can be exported')
    expect(d.plan.statements[0].reasons).not.toContain('Only reads can be exported')
  })
})

describe('target extraction', () => {
  it.each([
    ['DROP TABLE IF EXISTS public.orders', 'orders'],
    ['/* c */ drop view "Daily Revenue"', 'Daily Revenue'],
    ['DROP DATABASE shop', 'shop'],
    ['TRUNCATE TABLE ONLY `a``b`', 'a`b'],
    ['DELETE FROM shop.orders', 'orders'],
    ['UPDATE LOW_PRIORITY users SET a = 1', 'users'],
    ['ALTER TABLE users DROP COLUMN email', 'users'],
    ['db.getCollection("weird.name").drop()', 'weird.name'],
    ['db.users.updateMany({}, {$set: {a: 1}})', 'users'],
    ['SELECT 1', null]
  ])('%s → %s', (text, expected) => {
    expect(extractTargetName(text)).toBe(expected)
  })

  it('destructive detection reads the dangerous reasons', () => {
    expect(isDestructive({ text: '', dangerous: ['DROP TABLE'] })).toBe(true)
    expect(isDestructive({ text: '', dangerous: ['UPDATE without WHERE'] })).toBe(true)
    expect(isDestructive({ text: '', dangerous: ['$out replaces the target collection'] })).toBe(
      true
    )
    expect(isDestructive({ text: '', dangerous: ['calls pg_sleep'] })).toBe(false)
    expect(isDestructive({ text: '', dangerous: [] })).toBe(false)
  })
})
