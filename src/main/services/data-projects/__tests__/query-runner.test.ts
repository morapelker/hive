import { afterEach, describe, expect, it } from 'vitest'
import {
  DATA_HARD_ROW_CAP,
  DATA_STATUS_CHANNEL,
  type DataConnectionStatus,
  type DataQueryRequest,
  type MongoFindRequest
} from '../../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataProjectRecord,
  type DriverConnectInput,
  type MongoEngineService
} from '../contracts'
import { noopLogger, SerialQueue, QueueAbortedError } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { maskForHistory, maskMongoSecrets } from '../query-runner'
import { createSafetyGate } from '../safety-gate'
import {
  FakeDriver,
  MemoryRepository,
  MemorySecrets,
  deferred,
  makeRecord,
  rowsOutput
} from './engine-fixtures'

interface Harness {
  engine: DataEngineServiceInternals
  repo: MemoryRepository
  secrets: MemorySecrets
  drivers: FakeDriver[]
  events: Array<{ channel: string; payload: unknown }>
  configure: (fn: (d: FakeDriver) => void) => void
}

let harnesses: Harness[] = []

function setup(
  record: Partial<DataProjectRecord> = {},
  options: { idleMs?: number; txWatchMs?: number; secrets?: MemorySecrets } = {}
): Harness {
  const repo = new MemoryRepository([makeRecord(record)])
  const secrets = options.secrets ?? new MemorySecrets({ 'dp-1': { password: 's3cretPW' } })
  const drivers: FakeDriver[] = []
  const events: Array<{ channel: string; payload: unknown }> = []
  let configure: (d: FakeDriver) => void = () => {}
  const engine = createDataEngineService({
    repository: repo,
    secrets,
    publish: (channel, payload) => events.push({ channel, payload }),
    createDriver: (input: DriverConnectInput) => {
      const d = new FakeDriver(input)
      configure(d)
      drivers.push(d)
      return d
    },
    gate: createSafetyGate(),
    logger: noopLogger,
    idleMs: options.idleMs,
    txWatchMs: options.txWatchMs
  })
  const h: Harness = {
    engine,
    repo,
    secrets,
    drivers,
    events,
    configure: (fn) => {
      configure = fn
      for (const d of drivers) fn(d)
    }
  }
  harnesses.push(h)
  return h
}

afterEach(async () => {
  for (const h of harnesses) await h.engine.shutdown()
  harnesses = []
})

const req = (text: string, extra: Partial<DataQueryRequest> = {}): DataQueryRequest => ({
  dataProjectId: 'dp-1',
  queryId: `q-${Math.random().toString(36).slice(2)}`,
  text,
  database: 'shop',
  limit: 100,
  source: 'editor',
  ...extra
})

const ctx = { clientId: 'client-a' }

describe('query runner: pipeline', () => {
  it('runs reads in the sandbox with limit and hard cap, mapping offsets', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) => rowsOutput(['n'], [[sql.length]])
    })
    const res = await h.engine.execute(req('SELECT 1;\n  SELECT 22'), ctx)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.statements.map((s) => [s.text, s.start, s.end, s.classification])).toEqual([
      ['SELECT 1', 0, 8, 'read'],
      ['SELECT 22', 12, 21, 'read']
    ])
    const calls = h.drivers[0].calls
    expect(calls.map((c) => c.options.readOnlySandbox)).toEqual([true, true])
    expect(calls[0].options.limit).toBe(100)
    expect(calls[0].options.hardCap).toBe(DATA_HARD_ROW_CAP)
    expect(calls[0].options.database).toBe('shop')
    expect(res.database).toBe('shop')
    expect(h.repo.history).toHaveLength(1)
    expect(h.repo.history[0].status).toBe('ok')
    expect(h.repo.history[0].rowCount).toBe(2)
  })

  it('limit 0/null means no auto-limit', async () => {
    const h = setup()
    await h.engine.execute(req('SELECT 1', { limit: 0 }), ctx)
    await h.engine.execute(req('SELECT 1', { limit: null }), ctx)
    expect(h.drivers[0].calls.map((c) => c.options.limit)).toEqual([null, null])
  })

  it('empty text runs nothing', async () => {
    const h = setup()
    const res = await h.engine.execute(req('  -- just a comment\n'), ctx)
    expect(res).toMatchObject({ status: 'ok', statements: [] })
    expect(h.drivers).toHaveLength(0)
  })

  it('half-safe write → confirmation_required, then the token runs it unsandboxed', async () => {
    const h = setup()
    const r1 = req("SELECT 1; UPDATE users SET name = 'x' WHERE id = 1")
    const first = await h.engine.execute(r1, ctx)
    expect(first.status).toBe('confirmation_required')
    expect(h.drivers).toHaveLength(0)
    if (first.status !== 'confirmation_required') return
    expect(first.plan.statements[1].needsConfirmation).toBe(true)
    const second = await h.engine.execute(
      { ...r1, queryId: 'q2', confirmToken: first.confirmToken },
      ctx
    )
    expect(second.status).toBe('ok')
    expect(h.drivers[0].calls.map((c) => c.options.readOnlySandbox)).toEqual([false, false])
    // Token is single use.
    const third = await h.engine.execute(
      { ...r1, queryId: 'q3', confirmToken: first.confirmToken },
      ctx
    )
    expect(third.status).toBe('confirmation_required')
  })

  it('read-only mode blocks writes and records the block', async () => {
    const h = setup({ safeMode: 'read-only' })
    const res = await h.engine.execute(req('DELETE FROM users WHERE id = 1'), ctx)
    expect(res.status).toBe('blocked')
    expect(h.repo.history[0].status).toBe('blocked')
    expect(h.drivers).toHaveLength(0)
  })

  it('a sandbox rejection turns into confirmation_required ("tried to write") and stops', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) => {
        if (sql.includes('audit')) {
          throw new DataDriverError('cannot execute INSERT in a read-only transaction', {
            code: '25006',
            sandboxRejected: true
          })
        }
        return rowsOutput(['x'], [[1]])
      }
    })
    const r = req('SELECT 1; SELECT write_audit(); SELECT 3')
    const res = await h.engine.execute(r, ctx)
    expect(res.status).toBe('confirmation_required')
    if (res.status !== 'confirmation_required') return
    expect(res.plan.statements[1].reasons.join(' ')).toMatch(/tried to write/)
    expect(h.drivers[0].calls).toHaveLength(2)
    // Confirming re-runs the whole request outside the sandbox.
    h.configure((d) => {
      d.handler = () => rowsOutput(['x'], [[1]])
    })
    const again = await h.engine.execute(
      { ...r, queryId: 'again', confirmToken: res.confirmToken },
      ctx
    )
    expect(again.status).toBe('ok')
    expect(h.drivers[0].calls.slice(2).map((c) => c.options.readOnlySandbox)).toEqual([
      false,
      false,
      false
    ])
  })

  it('sandbox rejection in read-only mode → blocked', async () => {
    const h = setup({ safeMode: 'read-only' })
    h.configure((d) => {
      d.handler = () => {
        throw new DataDriverError('read-only', { sandboxRejected: true })
      }
    })
    const res = await h.engine.execute(req('SELECT f()'), ctx)
    expect(res.status).toBe('blocked')
  })

  it('maps driver errors with code/position/hint and redacts secrets; stopOnError', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) => {
        if (sql.startsWith('SELECT bad')) {
          throw new DataDriverError('syntax error near s3cretPW', {
            code: '42601',
            position: 7,
            hint: 'h'
          })
        }
        return rowsOutput(['x'], [[1]])
      }
    })
    const stop = await h.engine.execute(req('SELECT bad; SELECT 2'), ctx)
    expect(stop.status).toBe('ok')
    if (stop.status !== 'ok') return
    expect(stop.statements).toHaveLength(1)
    expect(stop.statements[0].error).toEqual({
      message: 'syntax error near ***',
      code: '42601',
      position: 7,
      hint: 'h'
    })
    expect(h.repo.history[0]).toMatchObject({ status: 'error', error: 'syntax error near ***' })

    const go = await h.engine.execute(req('SELECT bad; SELECT 2', { stopOnError: false }), ctx)
    expect(go.status === 'ok' && go.statements.map((s) => !!s.error)).toEqual([true, false])
  })

  it('reports extra result sets of one statement', async () => {
    const h = setup({ engine: 'mysql' })
    h.configure((d) => {
      d.handler = () => ({
        ...rowsOutput(['a'], [[1]]),
        moreOutputs: [rowsOutput(['b'], [[2]]).output]
      })
    })
    const res = await h.engine.execute(req('CALL two_sets()', { confirmToken: undefined }), ctx)
    // CALL is a write-class statement in half-safe: confirm first.
    expect(res.status).toBe('confirmation_required')
    if (res.status !== 'confirmation_required') return
    const run = await h.engine.execute(
      { ...req('CALL two_sets()'), queryId: 'qq', confirmToken: res.confirmToken },
      ctx
    )
    expect(run.status === 'ok' && run.statements.map((s) => [s.index, s.output?.kind])).toEqual([
      [0, 'rows'],
      [0, 'rows']
    ])
  })

  it('masks secrets in history', async () => {
    const h = setup({ engine: 'mysql', safeMode: 'off', environment: 'local' })
    await h.engine.execute(req("CREATE USER bob IDENTIFIED BY 'hunter22'"), ctx)
    expect(h.repo.history[0].text).not.toContain('hunter22')
  })

  it('does not record table-source queries in history', async () => {
    const h = setup()
    await h.engine.execute(req('SELECT 1', { source: 'table' }), ctx)
    expect(h.repo.history).toHaveLength(0)
  })
})

describe('query runner: cancellation', () => {
  it('cancels the running statement by queryId and returns finished statements', async () => {
    const h = setup()
    const gate = deferred<void>()
    h.configure((d) => {
      d.handler = async (sql) => {
        if (sql.includes('slow')) await new Promise(() => {})
        return rowsOutput(['x'], [[1]])
      }
    })
    const r = req('SELECT 1; SELECT slow(); SELECT 3', { queryId: 'cancel-me' })
    const running = h.engine.execute(r, ctx)
    await new Promise((res) => setTimeout(res, 20))
    gate.resolve()
    expect(await h.engine.cancel('cancel-me')).toEqual({ cancelled: true })
    const res = await running
    expect(res.status).toBe('cancelled')
    if (res.status !== 'cancelled') return
    expect(res.statements).toHaveLength(1)
    expect(h.drivers[0].cancelRequests).toBe(1)
    expect(h.repo.history[0].status).toBe('cancelled')
    expect(await h.engine.cancel('cancel-me')).toEqual({ cancelled: false })
  })

  it('a statement the server finished before the cancel landed keeps its result (it may have committed)', async () => {
    const h = setup({ safeMode: 'off' })
    const release = deferred<void>()
    h.configure((d) => {
      d.cancelCurrent = async () => {
        d.cancelRequests++
        release.resolve()
      }
      d.handler = async () => {
        await release.promise
        return { output: { kind: 'command', message: 'UPDATE 1', affectedRows: 1 } }
      }
    })
    const running = h.engine.execute(
      req('UPDATE t SET v = v + 1 WHERE id = 1', { queryId: 'late' }),
      ctx
    )
    await new Promise((res) => setTimeout(res, 10))
    await h.engine.cancel('late')
    const res = await running
    // The driver returned a result instead of a cancelled error: the write happened.
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.statements[0].output).toMatchObject({ affectedRows: 1 })
    expect(res.statements[0].notices).toEqual([
      'The cancel arrived after this statement had finished.'
    ])
    expect(h.repo.history.at(-1)).toMatchObject({ status: 'ok', rowCount: 1 })
  })

  it('a late cancel keeps the finished statement and stops before the next one', async () => {
    const h = setup({ safeMode: 'off' })
    const release = deferred<void>()
    h.configure((d) => {
      d.cancelCurrent = async () => {
        d.cancelRequests++
        release.resolve()
      }
      d.handler = async (sql) => {
        if (sql.startsWith('UPDATE')) await release.promise
        return { output: { kind: 'command', message: 'OK', affectedRows: 1 } }
      }
    })
    const running = h.engine.execute(
      req('UPDATE t SET v = 1 WHERE id = 1; DELETE FROM t WHERE id = 3', { queryId: 'late2' }),
      ctx
    )
    await new Promise((res) => setTimeout(res, 10))
    await h.engine.cancel('late2')
    const res = await running
    expect(res.status).toBe('cancelled')
    if (res.status !== 'cancelled') return
    expect(res.statements).toHaveLength(1)
    expect(res.statements[0].output).toMatchObject({ affectedRows: 1 })
    expect(h.drivers[0].calls).toHaveLength(1)
  })

  it('a statement the driver reports as interrupted (PG 57014, MySQL 1317) is cancelled', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = async () => new Promise(() => {})
    })
    const running = h.engine.execute(req('SELECT slow()', { queryId: 'stop' }), ctx)
    await new Promise((res) => setTimeout(res, 10))
    await h.engine.cancel('stop')
    expect(await running).toMatchObject({ status: 'cancelled', statements: [] })
  })

  it('cancelling a queued query does not wait for the one ahead of it', async () => {
    const h = setup()
    const block = deferred<void>()
    h.configure((d) => {
      d.handler = async (sql) => {
        if (sql.includes('first')) await block.promise
        return rowsOutput(['x'], [[1]])
      }
    })
    const first = h.engine.execute(req('SELECT first()', { queryId: 'first' }), ctx)
    await new Promise((res) => setTimeout(res, 10))
    const second = h.engine.execute(req('SELECT second()', { queryId: 'second' }), ctx)
    await new Promise((res) => setTimeout(res, 10))
    await h.engine.cancel('second')
    expect(await second).toMatchObject({ status: 'cancelled', statements: [] })
    block.resolve()
    expect((await first).status).toBe('ok')
    expect(h.drivers[0].calls.map((c) => c.statement)).toEqual(['SELECT first()'])
  })

  it('releaseClient cancels the client’s queries only', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = async () => new Promise(() => {})
    })
    const mine = h.engine.execute(req('SELECT a()', { queryId: 'mine' }), { clientId: 'gone' })
    await new Promise((res) => setTimeout(res, 10))
    h.engine.releaseClient('gone')
    expect((await mine).status).toBe('cancelled')
  })

  it('refuses a duplicate queryId', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = async () => new Promise(() => {})
    })
    void h.engine.execute(req('SELECT a()', { queryId: 'dup' }), ctx)
    await new Promise((res) => setTimeout(res, 10))
    await expect(
      h.engine.execute(req('SELECT b()', { queryId: 'dup' }), ctx)
    ).rejects.toMatchObject({
      code: 'DATA_BUSY'
    })
    await h.engine.cancel('dup')
  })
})

describe('query runner: connection loss', () => {
  it('re-runs an idempotent read once on a fresh connection', async () => {
    const h = setup()
    let failures = 0
    h.configure((d) => {
      d.handler = (_sql, _o, drv) => {
        if (failures === 0) {
          failures++
          drv.connected = false
          throw new DataDriverError('Connection terminated unexpectedly', { code: 'ECONNRESET' })
        }
        return rowsOutput(['x'], [[1]])
      }
    })
    const res = await h.engine.execute(req('SELECT 1'), ctx)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.statements[0].error).toBeUndefined()
    expect(res.statements[0].notices?.[0]).toMatch(/connection was lost/)
    expect(h.drivers).toHaveLength(2)
  })

  it('never re-runs a write after a lost connection', async () => {
    const h = setup({ safeMode: 'off' })
    h.configure((d) => {
      d.handler = (_sql, _o, drv) => {
        drv.connected = false
        throw new DataDriverError('server has gone away', { code: '2006' })
      }
    })
    const res = await h.engine.execute(req('UPDATE t SET a = 1 WHERE id = 2'), ctx)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.statements[0].error?.message).toMatch(/may or may not have been applied/)
    expect(h.drivers[0].calls).toHaveLength(1)
    expect(h.drivers.reduce((n, d) => n + d.calls.length, 0)).toBe(1)
  })
})

describe('lost transactions', () => {
  /** A session that ran BEGIN and then sits idle inside the transaction. */
  const inTransaction = async (h: Harness): Promise<FakeDriver> => {
    h.configure((d) => {
      d.handler = (sql, _o, drv) => {
        if (/^BEGIN/i.test(sql)) drv.inTransaction = true
        if (/^(COMMIT|ROLLBACK)/i.test(sql)) drv.inTransaction = false
        return { output: { kind: 'command', message: sql, affectedRows: 1 } }
      }
    })
    const res = await h.engine.execute(req('BEGIN; INSERT INTO t VALUES (1)'), ctx)
    expect(res).toMatchObject({ status: 'ok', inTransaction: true })
    expect(h.engine.status('dp-1').inTransaction).toBe(true)
    return h.drivers[0]
  }

  it('a session that died idle inside BEGIN is published at once, and the next run reports the rollback instead of committing on a fresh session', async () => {
    const h = setup({ safeMode: 'off' }, { txWatchMs: 10 })
    const first = await inTransaction(h)
    // wait_timeout / idle_in_transaction_session_timeout: the server drops the session.
    first.connected = false
    await new Promise((res) => setTimeout(res, 40))
    const status = h.engine.status('dp-1')
    expect(status.state).toBe('error')
    expect(status.inTransaction).toBeUndefined()
    expect(status.error).toMatch(/transaction was open; the server rolled the transaction back/)
    const published = h.events.filter((e) => e.channel === DATA_STATUS_CHANNEL).at(-1)
      ?.payload as DataConnectionStatus
    expect(published.state).toBe('error')

    const commit = await h.engine.execute(req('COMMIT'), ctx)
    expect(commit.status).toBe('ok')
    if (commit.status !== 'ok') return
    expect(commit.inTransaction).toBe(false)
    expect(commit.statements[0].output).toBeNull()
    expect(commit.statements[0].error).toMatchObject({ code: 'CONNECTION_LOST' })
    expect(commit.statements[0].error?.message).toMatch(/rolled the transaction back/)
    // COMMIT ran nowhere: not on the dead session, not on a silently reopened one.
    expect(h.drivers).toHaveLength(1)
    expect(first.calls.map((c) => c.statement)).not.toContain('COMMIT')
    expect(h.repo.history.at(-1)).toMatchObject({ text: 'COMMIT', status: 'error' })

    // Reported once: the next run reconnects.
    const next = await h.engine.execute(req('SELECT 1'), ctx)
    expect(next.status === 'ok' && next.statements[0].error).toBeUndefined()
    expect(h.drivers).toHaveLength(2)
    expect(h.engine.status('dp-1').state).toBe('connected')
  })

  it('is reported even when the run comes before the watcher noticed', async () => {
    const h = setup({ safeMode: 'off' })
    const first = await inTransaction(h)
    first.connected = false
    const commit = await h.engine.execute(req('COMMIT'), ctx)
    expect(commit.status === 'ok' && commit.statements[0].error?.code).toBe('CONNECTION_LOST')
    expect(h.drivers).toHaveLength(1)
  })

  it('table pages and introspection reconnect without consuming the report', async () => {
    const h = setup({ safeMode: 'off' })
    const first = await inTransaction(h)
    first.connected = false
    h.configure((d) => {
      d.handler = () => rowsOutput(['id'], [[1]])
    })
    await h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: 'page',
        ref: { schema: 'public', name: 'users' },
        limit: 10,
        offset: 0
      },
      ctx
    )
    await h.engine.objects('dp-1', 'shop')
    expect(h.drivers).toHaveLength(2)
    const commit = await h.engine.execute(req('COMMIT'), ctx)
    expect(commit.status === 'ok' && commit.statements[0].error?.code).toBe('CONNECTION_LOST')
    expect(h.drivers[1].calls.map((c) => c.statement)).not.toContain('COMMIT')
  })

  it('a session killed from the process list is noticed on refresh', async () => {
    const h = setup({ safeMode: 'off' })
    const first = await inTransaction(h)
    first.killProcess = async () => {
      first.connected = false
    }
    await h.engine.kill('dp-1', '42', 'connection')
    expect(h.engine.status('dp-1')).toMatchObject({ state: 'error' })
    const res = await h.engine.execute(req('INSERT INTO t VALUES (2)'), ctx)
    expect(res.status === 'ok' && res.statements[0].error?.code).toBe('CONNECTION_LOST')
  })

  it('a reconnect the runner already reported does not report again', async () => {
    const h = setup({ safeMode: 'off' })
    const first = await inTransaction(h)
    first.handler = (_sql, _o, drv) => {
      drv.connected = false
      throw new DataDriverError('server has gone away', { code: '2006' })
    }
    const lost = await h.engine.execute(req('INSERT INTO t VALUES (2)'), ctx)
    expect(lost.status === 'ok' && lost.statements[0].error?.message).toMatch(
      /open transaction was rolled back/
    )
    const next = await h.engine.execute(req('SELECT 1'), ctx)
    expect(next.status === 'ok' && next.statements[0].error).toBeUndefined()
  })

  it('disconnecting during a transaction is reported on the next run', async () => {
    const h = setup({ safeMode: 'off' })
    await inTransaction(h)
    await h.engine.disconnect('dp-1')
    const res = await h.engine.execute(req('COMMIT'), ctx)
    expect(res.status === 'ok' && res.statements[0].error?.message).toMatch(
      /closed while a transaction was open/
    )
    expect(h.drivers[0].calls.map((c) => c.statement)).not.toContain('COMMIT')
  })

  it('a failed side connection (introspection) never drops a session inside a transaction', async () => {
    const h = setup({ safeMode: 'off' })
    const first = await inTransaction(h)
    let failures = 0
    first.listObjects = async () => {
      if (failures++ === 0)
        throw new DataDriverError('Connection terminated unexpectedly', { code: 'ECONNRESET' })
      return { objects: [] }
    }
    expect(await h.engine.objects('dp-1', 'shop')).toEqual({ objects: [] })
    expect(first.closes).toBe(0)
    expect(h.drivers).toHaveLength(1)
    expect(h.engine.status('dp-1').inTransaction).toBe(true)
    const commit = await h.engine.execute(req('COMMIT'), ctx)
    expect(commit.status === 'ok' && commit.statements[0].error).toBeUndefined()
    expect(first.calls.at(-1)?.statement).toBe('COMMIT')
  })

  it('a session closed without a transaction reconnects silently', async () => {
    const h = setup({ safeMode: 'off' })
    await h.engine.execute(req('SELECT 1'), ctx)
    h.drivers[0].connected = false
    const res = await h.engine.execute(req('COMMIT'), ctx)
    expect(res.status === 'ok' && res.statements[0].error).toBeUndefined()
    expect(h.drivers).toHaveLength(2)
  })
})

describe('query runner: session database and backslash mode', () => {
  it('a USE inside the request carries over to the statements after it', async () => {
    const h = setup({ engine: 'mysql', safeMode: 'off' })
    h.configure((d) => {
      d.handler = (sql, _o, drv) => {
        if (/^USE /i.test(sql)) drv.currentDatabase = sql.slice(4)
        return { output: { kind: 'command', message: 'OK' } }
      }
    })
    await h.engine.execute(req('USE archive; DELETE FROM t WHERE id = 1'), ctx)
    expect(h.drivers[0].calls.map((c) => [c.statement, c.options.database])).toEqual([
      ['USE archive', 'shop'],
      ['DELETE FROM t WHERE id = 1', 'archive']
    ])
    // The next request starts in the tab's database again.
    await h.engine.execute(req('SELECT 1'), ctx)
    expect(h.drivers[0].calls.at(-1)?.options.database).toBe('shop')
  })

  it('MySQL text with a backslash is split and classified with the session mode', async () => {
    const h = setup({ engine: 'mysql' })
    h.configure((d) => {
      d.backslashEscapes = false
      d.handler = () => rowsOutput(['x'], [[1]])
    })
    // NO_BACKSLASH_ESCAPES: 'a\' is a whole string, so these are two plain reads.
    const res = await h.engine.execute(req("SELECT 'a\\'; SELECT 2"), ctx)
    expect(res.status).toBe('ok')
    expect(h.drivers[0].calls.map((c) => c.statement)).toEqual(["SELECT 'a\\'", 'SELECT 2'])
  })

  it('stops when a statement changes NO_BACKSLASH_ESCAPES under the rest of the text', async () => {
    const h = setup({ engine: 'mysql', safeMode: 'off' })
    h.configure((d) => {
      d.backslashEscapes = true
      d.handler = (sql, _o, drv) => {
        if (/sql_mode/i.test(sql)) drv.backslashEscapes = false
        return { output: { kind: 'command', message: 'OK' } }
      }
    })
    const res = await h.engine.execute(
      req("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'; UPDATE t SET p = 'C:\\\\x' WHERE id = 1"),
      ctx
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.statements[1].error?.code).toBe('SQL_MODE_CHANGED')
    expect(h.drivers[0].calls).toHaveLength(1)
  })
})

describe('query runner: MongoDB database context', () => {
  const production = {
    engine: 'mongodb' as const,
    environment: 'production' as const,
    config: { host: '127.0.0.1', port: 27017, database: 'shop' }
  }

  it('dropDatabase after `use x` names x in the danger text and the typed confirmation', async () => {
    const h = setup(production)
    const res = await h.engine.execute(req('use archive_2023\ndb.dropDatabase()'), ctx)
    expect(res.status).toBe('confirmation_required')
    if (res.status !== 'confirmation_required') return
    expect(res.plan.typedConfirmation).toBe('archive_2023')
    expect(res.plan.statements[1].dangerous.join(' ')).toContain('"archive_2023"')
    const sibling = await h.engine.execute(
      req('db.getSiblingDB("tmp_v").dropDatabase()', { queryId: 'q-sibling' }),
      ctx
    )
    expect(sibling.status === 'confirmation_required' && sibling.plan.typedConfirmation).toBe(
      'tmp_v'
    )
    const plain = await h.engine.execute(
      req('db.dropDatabase()', { queryId: 'q-plain', database: 'other' }),
      ctx
    )
    expect(plain.status === 'confirmation_required' && plain.plan.typedConfirmation).toBe('other')
  })

  it('each statement runs in the database it was confirmed for', async () => {
    const h = setup({ engine: 'mongodb', safeMode: 'off', config: { database: 'shop' } })
    await h.engine.execute(req('db.a.find({})\nuse archive\ndb.b.find({})'), ctx)
    expect(h.drivers[0].calls.map((c) => c.options.database)).toEqual(['shop', 'shop', 'archive'])
    // '(connection default)': the configured database, not where an earlier `use` left it.
    await h.engine.execute(req('db.c.find({})', { database: undefined }), ctx)
    expect(h.drivers[0].calls.at(-1)?.options.database).toBe('shop')
  })

  it("'(connection default)' without a configured database runs in mongosh's default, never where another tab's `use` left the session", async () => {
    const h = setup({ engine: 'mongodb', safeMode: 'off', config: { host: '127.0.0.1' } })
    h.configure((d) => {
      d.handler = (statement, _options, driver) => {
        const use = /^use (\w+)$/.exec(statement)
        if (use) driver.currentDatabase = use[1]
        return { output: { kind: 'command', message: `OK ${statement}` } }
      }
    })
    await h.engine.execute(req('use archive\ndb.a.find({})', { queryId: 'q-tab-a' }), ctx)
    expect(h.engine.status('dp-1').currentDatabase).toBe('archive')
    const res = await h.engine.execute(
      req('db.orders.deleteMany({ status: "old" })', { queryId: 'q-tab-b', database: undefined }),
      ctx
    )
    expect(h.drivers[0].calls.map((c) => [c.statement, c.options.database])).toEqual([
      ['use archive', 'shop'],
      ['db.a.find({})', 'archive'],
      ['db.orders.deleteMany({ status: "old" })', 'test']
    ])
    expect(res.status === 'ok' && res.database).toBe('test')
    expect(h.repo.history.at(-1)?.database).toBe('test')
  })

  it("'(connection default)' confirmations name mongosh's default database", async () => {
    const h = setup({
      engine: 'mongodb',
      environment: 'production',
      config: { host: '127.0.0.1' }
    })
    h.configure((d) => {
      d.handler = (statement, _options, driver) => {
        const use = /^use (\w+)$/.exec(statement)
        if (use) driver.currentDatabase = use[1]
        return { output: { kind: 'command', message: `OK ${statement}` } }
      }
    })
    const moved = await h.engine.execute(req('use archive', { queryId: 'q-use' }), ctx)
    expect(moved.status).toBe('ok')
    const drop = await h.engine.execute(
      req('db.dropDatabase()', { queryId: 'q-drop', database: undefined }),
      ctx
    )
    expect(drop.status).toBe('confirmation_required')
    if (drop.status !== 'confirmation_required') return
    expect(drop.plan.typedConfirmation).toBe('test')
    expect(drop.plan.database).toBe('test')
    const del = await h.engine.execute(
      req('db.orders.deleteMany({})', { queryId: 'q-del', database: undefined }),
      ctx
    )
    expect(del.status === 'confirmation_required' && del.plan.database).toBe('test')
  })
})

describe('history masking', () => {
  it('masks mongosh passwords: quoted keys, positional arguments, concatenation and URLs', () => {
    const cases: Array<[string, string]> = [
      [
        'db.runCommand({"createUser": "app", "pwd": "MongoPw1", "roles": []})',
        'db.runCommand({"createUser": "app", "pwd": "***", "roles": []})'
      ],
      [
        "db.adminCommand({'updateUser':'app','pwd':'MongoPw2'})",
        "db.adminCommand({'updateUser':'app','pwd':'***'})"
      ],
      [
        'db.createUser({ user: "u", pwd: "a\\"b" + `c`, roles: [] })',
        'db.createUser({ user: "u", pwd: "***" + `***`, roles: [] })'
      ],
      ['db.updateUser("u", { ["pwd"]: "x1" })', 'db.updateUser("u", { ["pwd"]: "***" })'],
      ["db.changeUserPassword('app', 'NewPw3')", "db.changeUserPassword('app', '***')"],
      ['db.auth("app", "AuthPw4")', 'db.auth("app", "***")'],
      // Dotted / dashed $set paths and token keys (the renderer's persisted drafts use the
      // same masker).
      [
        'db.users.updateOne({ _id: 1 }, { $set: { "auth.password": "Hunter2", "smtp-password": "h2" } })',
        'db.users.updateOne({ _id: 1 }, { $set: { "auth.password": "***", "smtp-password": "***" } })'
      ],
      [
        'db.s.insertOne({ sessionToken: "tok", apiKey: "k" })',
        'db.s.insertOne({ sessionToken: "***", apiKey: "***" })'
      ],
      [
        'db.users.insertOne({ name: "x", newPassword: "p5", passwordHint: 1 })',
        'db.users.insertOne({ name: "x", newPassword: "***", passwordHint: 1 })'
      ],
      [
        'connect("mongodb://root:mongopw@127.0.0.1:27018/admin")',
        'connect("mongodb://root:***@127.0.0.1:27018/admin")'
      ]
    ]
    for (const [input, expected] of cases) expect(maskForHistory('mongodb', input)).toBe(expected)
    // Ordinary fields and filters stay readable.
    const plain = 'db.users.find({ name: "pwd", status: \'a\' }).sort({ pwdChangedAt: -1 })'
    expect(maskForHistory('mongodb', plain)).toBe(plain)
    expect(maskMongoSecrets('x'.repeat(200_000) + 'pwd'.repeat(30_000))).toHaveLength(290_000)
  })

  it('masks SQL in the engine’s dialect and leaves SQL values readable', () => {
    // PostgreSQL strings take no backslash escapes; MySQL's do.
    expect(maskForHistory('postgres', "SELECT 'C:\\', password 'PgPw1'")).toBe(
      "SELECT 'C:\\', password '***'"
    )
    expect(maskForHistory('mysql', "SELECT 'it\\'s', password 'MyPw2'")).toBe(
      "SELECT 'it\\'s', password '***'"
    )
    for (const text of [
      'UPDATE users SET password = NULL WHERE last_login IS NULL',
      "INSERT INTO app_settings (name, value) VALUES ('smtp_password', 'x')"
    ])
      expect(maskForHistory('mysql', text)).toBe(text)
    expect(
      maskForHistory('postgres', "SELECT dblink_connect('host=h password=''S3cret Pw'' dbname=d')")
    ).toBe("SELECT dblink_connect('host=h password=''***'' dbname=d')")
  })

  it('masks a literal the history cut falls into, without masking the whole request', () => {
    // The cut at 100 000 characters falls inside 'CutSecret1'.
    const head = `SELECT 1;\n${'-- pad\n'.repeat(14_279)}`
    const text = `${head}CREATE USER u IDENTIFIED BY 'CutSecret1';\n${'SELECT 2;\n'.repeat(1_600_000)}`
    expect(text.length).toBeGreaterThan(16_000_000)
    const t0 = performance.now()
    const masked = maskForHistory('mysql', text)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(masked).not.toContain('CutSec')
    expect(masked.endsWith('\n-- … truncated')).toBe(true)
    expect(masked.length).toBeLessThanOrEqual(100_000 + '\n-- … truncated'.length)
    expect(maskForHistory('mysql', masked)).toBe(masked)
  })

  it('masks the error column too: syntax errors echo the statement', async () => {
    const h = setup({ engine: 'mysql', safeMode: 'off', environment: 'local' })
    h.configure((d) => {
      d.handler = () => {
        throw new DataDriverError(
          "You have an error in your SQL syntax; check the manual near 'CREAT USER 'u'@'%' IDENTIFIED BY 'TopSecret1'' at line 1",
          { code: '1064' }
        )
      }
    })
    const res = await h.engine.execute(req("CREAT USER 'u'@'%' IDENTIFIED BY 'TopSecret1'"), ctx)
    // The editor shows the user their own text; only what is stored is masked.
    expect(res.status === 'ok' && res.statements[0].error?.message).toContain('TopSecret1')
    const row = h.repo.history.at(-1)
    expect(row?.status).toBe('error')
    expect(row?.text).not.toContain('TopSecret1')
    expect(row?.error).not.toContain('TopSecret1')
    expect(
      maskForHistory(
        'clickhouse',
        "Code: 62. DB::Exception: Syntax error: failed at position 1 ('CREAT'): CREAT USER u IDENTIFIED BY 'TopSecretCH'. Expected one of"
      )
    ).not.toContain('TopSecretCH')
  })

  it('masks history written outside the query runner (the Mongo service) centrally', async () => {
    const repo = new MemoryRepository([makeRecord({ engine: 'mongodb' })])
    const engine = createDataEngineService({
      repository: repo,
      secrets: new MemorySecrets(),
      gate: createSafetyGate(),
      logger: noopLogger,
      createMongoEngineService: (deps) =>
        ({
          find: async () => {
            deps.recordHistory({
              dataProjectId: 'dp-1',
              database: 'shop',
              text: 'db.getCollection("users").insertOne({ name: "a", pwd: "MongoPw9" })',
              status: 'error',
              durationMs: 1,
              rowCount: null,
              error: 'E11000 duplicate key: { pwd: "MongoPw9" }',
              executedAt: '2026-01-01T00:00:00.000Z'
            })
            return {}
          }
        }) as unknown as MongoEngineService
    })
    await engine.mongo.find({} as MongoFindRequest, ctx)
    expect(repo.history.at(-1)).toMatchObject({
      text: 'db.getCollection("users").insertOne({ name: "a", pwd: "***" })',
      error: 'E11000 duplicate key: { pwd: "***" }'
    })
    await engine.shutdown()
  })
})

describe('connection manager via the engine', () => {
  it('publishes connecting → connected and reports the session database', async () => {
    const h = setup()
    const status = await h.engine.connect('dp-1')
    expect(status).toMatchObject({
      dataProjectId: 'dp-1',
      state: 'connected',
      serverVersion: 'fake 1.0',
      currentDatabase: 'shop'
    })
    const states = h.events
      .filter((e) => e.channel === DATA_STATUS_CHANNEL)
      .map((e) => (e.payload as DataConnectionStatus).state)
    expect(states).toEqual(['connecting', 'connected'])
    expect(h.drivers[0].input.secrets.password).toBe('s3cretPW')
  })

  it('dedupes concurrent connects', async () => {
    const h = setup()
    await Promise.all([
      h.engine.connect('dp-1'),
      h.engine.connect('dp-1'),
      h.engine.databases('dp-1')
    ])
    expect(h.drivers).toHaveLength(1)
    expect(h.drivers[0].connects).toBe(1)
  })

  it('PostgreSQL opens one driver per database; MySQL one per project', async () => {
    const pg = setup()
    await pg.engine.objects('dp-1', 'shop')
    await pg.engine.objects('dp-1', 'analytics')
    expect(pg.drivers.map((d) => d.input.database)).toEqual(['shop', 'analytics'])
    const my = setup({ engine: 'mysql', id: 'dp-1' })
    await my.engine.objects('dp-1', 'shop')
    await my.engine.objects('dp-1', 'other')
    expect(my.drivers).toHaveLength(1)
  })

  it('secrets that cannot be read → DATA_CREDENTIALS_REQUIRED and an error status', async () => {
    const secrets = new MemorySecrets()
    secrets.failing.add('dp-1')
    const h = setup({}, { secrets })
    await expect(h.engine.connect('dp-1')).rejects.toMatchObject({
      code: 'DATA_CREDENTIALS_REQUIRED'
    })
    expect(h.engine.status('dp-1').state).toBe('error')
  })

  it('an authentication failure asks for credentials; other failures are DATA_CONNECTION_FAILED', async () => {
    const h = setup()
    h.configure((d) => {
      d.failConnect = new DataDriverError(
        "Access denied for user 'root' (using password: YES) s3cretPW",
        { code: '1045' }
      )
    })
    await expect(h.engine.connect('dp-1')).rejects.toMatchObject({
      code: 'DATA_CREDENTIALS_REQUIRED'
    })
    const err = (await h.engine.connect('dp-1').catch((e: Error) => e)) as Error
    expect(err.message).not.toContain('s3cretPW')
    h.configure((d) => {
      d.failConnect = new DataDriverError('connect ECONNREFUSED 127.0.0.1:1', {
        code: 'ECONNREFUSED'
      })
    })
    await expect(h.engine.connect('dp-1')).rejects.toMatchObject({ code: 'DATA_CONNECTION_FAILED' })
    expect(h.engine.status('dp-1')).toMatchObject({
      state: 'error',
      error: expect.stringContaining('ECONNREFUSED')
    })
  })

  it('unknown project → DATA_NOT_FOUND', async () => {
    const h = setup()
    await expect(h.engine.connect('nope')).rejects.toMatchObject({ code: 'DATA_NOT_FOUND' })
  })

  it('closes idle connections, but never during an open transaction', async () => {
    const h = setup({}, { idleMs: 30 })
    await h.engine.connect('dp-1')
    h.drivers[0].inTransaction = true
    await new Promise((res) => setTimeout(res, 80))
    expect(h.drivers[0].closes).toBe(0)
    h.drivers[0].inTransaction = false
    await new Promise((res) => setTimeout(res, 80))
    expect(h.drivers[0].closes).toBe(1)
    expect(h.engine.status('dp-1').state).toBe('disconnected')
  })

  it('invalidate closes the drivers and publishes disconnected', async () => {
    const h = setup()
    await h.engine.connect('dp-1')
    await h.engine.invalidate('dp-1')
    expect(h.drivers[0].closes).toBe(1)
    const last = h.events.filter((e) => e.channel === DATA_STATUS_CHANNEL).at(-1)
      ?.payload as DataConnectionStatus
    expect(last.state).toBe('disconnected')
  })

  it('USE updates currentDatabase in the response and the status', async () => {
    const h = setup({ engine: 'mysql' })
    h.configure((d) => {
      d.handler = (sql, _o, drv) => {
        if (/^USE /i.test(sql)) drv.currentDatabase = sql.slice(4)
        return { output: { kind: 'command', message: 'OK' } }
      }
    })
    const res = await h.engine.execute(req('USE other', { database: undefined }), ctx)
    expect(res.status === 'ok' && res.database).toBe('other')
    expect(h.engine.status('dp-1').currentDatabase).toBe('other')
  })
})

describe('engine: misc operations', () => {
  it('mongodb requests are split/classified with the mongo shell grammar', async () => {
    const h = setup({ engine: 'mongodb' })
    const res = await h.engine.execute(req('db.users.find({}); db.users.deleteMany({})'), ctx)
    expect(res.status).toBe('confirmation_required')
    if (res.status !== 'confirmation_required') return
    expect(res.plan.statements.map((s) => s.classification)).toEqual(['read', 'write'])
  })

  it('kill is refused in read-only mode and allowed otherwise', async () => {
    const ro = setup({ safeMode: 'read-only' })
    await expect(ro.engine.kill('dp-1', '12', 'query')).rejects.toMatchObject({
      code: 'DATA_FORBIDDEN'
    })
    const rw = setup()
    await rw.engine.kill('dp-1', '12', 'connection')
    expect(rw.drivers[0].killed).toEqual([{ id: '12', scope: 'connection' }])
  })

  it('sampleRows needs AI data access and runs sandboxed with a tiny cap', async () => {
    const off = setup()
    await expect(
      off.engine.sampleRows('dp-1', { name: 'users', schema: 'public' }, 10)
    ).rejects.toMatchObject({
      code: 'DATA_FORBIDDEN'
    })
    const on = setup({ allowAiDataAccess: true })
    on.configure((d) => {
      d.handler = () => rowsOutput(['id'], [[1]])
    })
    const out = await on.engine.sampleRows('dp-1', { name: 'users', schema: 'public' }, 500)
    expect(out.kind).toBe('rows')
    const call = on.drivers[0].calls[0]
    expect(call.statement).toBe('SELECT * FROM "public"."users" LIMIT 50')
    expect(call.options).toMatchObject({ readOnlySandbox: true, limit: 50, hardCap: 50 })
  })

  it('testConnection uses typed secrets over stored ones, measures latency and always closes', async () => {
    const h = setup()
    const ok = await h.engine.testConnection({
      engine: 'postgres',
      config: { host: 'db', port: 5432, user: 'u' },
      secrets: { password: 'typedPW1' },
      dataProjectId: 'dp-1'
    })
    expect(ok).toMatchObject({
      ok: true,
      serverVersion: 'fake 1.0',
      databases: ['shop', 'postgres']
    })
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0)
    expect(h.drivers[0].input.secrets.password).toBe('typedPW1')
    expect(h.drivers[0].closes).toBe(1)

    h.configure((d) => {
      d.failConnect = new Error('password authentication failed: typedPW2')
    })
    const bad = await h.engine.testConnection({
      engine: 'postgres',
      config: { host: 'db' },
      secrets: { password: 'typedPW2' }
    })
    expect(bad.ok).toBe(false)
    expect(bad.error).not.toContain('typedPW2')
    expect(h.drivers[1].closes).toBe(1)
  })

  it('testConnection returns the SSH tunnel notice (host key fingerprint on first use)', async () => {
    const notice =
      'SSH host key of bastion:22 (SHA256:abc) is not in ~/.ssh/known_hosts; accepted on first use.'
    const closed: string[] = []
    const engine = createDataEngineService({
      repository: new MemoryRepository([makeRecord()]),
      secrets: new MemorySecrets(),
      gate: createSafetyGate(),
      logger: noopLogger,
      createDriver: (input) => new FakeDriver(input),
      openTunnel: async () => ({
        localHost: '127.0.0.1',
        localPort: 40001,
        hostKeyFingerprint: 'SHA256:abc',
        notice,
        isOpen: () => true,
        onClose: () => () => {},
        close: async () => {
          closed.push('tunnel')
        }
      })
    })
    const res = await engine.testConnection({
      engine: 'postgres',
      config: {
        host: 'db.internal',
        port: 5432,
        ssh: { enabled: true, host: 'bastion', port: 22, username: 'me', authMethod: 'password' }
      },
      secrets: { password: 'pw', sshPassword: 'sshpw' }
    })
    expect(res).toMatchObject({ ok: true, notice })
    expect(closed).toEqual(['tunnel'])
    await engine.shutdown()
  })

  it('describe results are cached until a DDL statement runs', async () => {
    const h = setup({ safeMode: 'off' })
    await h.engine.describe('dp-1', { name: 'users', schema: 'public' })
    await h.engine.describe('dp-1', { name: 'users', schema: 'public' })
    const describes = (): number => h.drivers[0].calls.length
    expect(describes()).toBe(0)
    let n = 0
    h.drivers[0].describe = async (ref) => {
      n++
      return {
        ref,
        kind: 'table',
        columns: [],
        indexes: [],
        foreignKeys: [],
        triggers: [],
        primaryKey: []
      }
    }
    await h.engine.describe('dp-1', { name: 'users', schema: 'public' })
    expect(n).toBe(0)
    await h.engine.execute(req('ALTER TABLE users ADD COLUMN x int'), ctx)
    await h.engine.describe('dp-1', { name: 'users', schema: 'public' })
    expect(n).toBe(1)
  })
})

describe('SerialQueue', () => {
  it('runs tasks one at a time in order and drops aborted waiters', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    const gate = deferred<void>()
    const a = q.run(async () => {
      order.push('a:start')
      await gate.promise
      order.push('a:end')
    })
    const controller = new AbortController()
    const b = q.run(async () => {
      order.push('b')
    }, controller.signal)
    const c = q.run(async () => {
      order.push('c')
    })
    controller.abort()
    await expect(b).rejects.toBeInstanceOf(QueueAbortedError)
    gate.resolve()
    await a
    await c
    expect(order).toEqual(['a:start', 'a:end', 'c'])
  })
})
