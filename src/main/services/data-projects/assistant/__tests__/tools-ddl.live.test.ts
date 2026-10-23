// @vitest-environment node
// LIVE: get_table_ddl over the real engine and drivers never hands the model a credential that
// the server's own DDL carries (here: a view whose definition embeds a conninfo string and a URL
// with a password, the shape of a dblink view or a FEDERATED CONNECTION). Gated: TEDOOO_DP_IT=1.
// Creates only tmp_fix_f_* views and drops them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DataEngine, DataObjectRef } from '../../../../../shared/data-projects/types'
import type { DataDriver } from '../../contracts'
import { noopLogger } from '../../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../../engine-service'
import { createMysqlDriver } from '../../drivers/mysql'
import { createPostgresDriver } from '../../drivers/postgres'
import { createSafetyGate } from '../../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from '../../__tests__/engine-fixtures'
import { AssistantToolbox } from '../tools'
import { toolContext } from './fakes'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip

const VIEW = 'tmp_fix_f_conn'
const SECRETS = ['LiveConnPw1', 'LiveUrlPw2']

const TARGETS: Array<{ engine: DataEngine; port: number; user: string; password: string }> = [
  { engine: 'postgres', port: 15432, user: 'postgres', password: 'pgpw' },
  { engine: 'mysql', port: 13306, user: 'root', password: 'rootpw' },
  { engine: 'mariadb', port: 13307, user: 'root', password: 'rootpw' }
]

for (const target of TARGETS) {
  describe(`get_table_ddl masking (live ${target.engine})`, () => {
    const id = `ddl-${target.engine}`
    const config = { host: '127.0.0.1', port: target.port, user: target.user, database: 'shop' }
    const pg = target.engine === 'postgres'
    const ref: DataObjectRef = { name: VIEW, database: 'shop', ...(pg ? { schema: 'public' } : {}) }
    let engine: DataEngineServiceInternals
    let admin: DataDriver
    const adminRun = async (sql: string): Promise<void> => {
      await admin.execute(sql, { limit: null, hardCap: 10, readOnlySandbox: false })
    }

    beforeAll(async () => {
      if (!LIVE) return
      engine = createDataEngineService({
        repository: new MemoryRepository([
          makeRecord({ id, engine: target.engine, config, safeMode: 'read-only' })
        ]),
        secrets: new MemorySecrets({ [id]: { password: target.password } }),
        gate: createSafetyGate(),
        logger: noopLogger
      })
      const input = {
        project: makeRecord({ id: `${id}-admin`, engine: target.engine, config }),
        secrets: { password: target.password },
        redact: (t: string) => t
      }
      admin = pg ? createPostgresDriver(input) : createMysqlDriver(input)
      await admin.connect()
      await adminRun(`DROP VIEW IF EXISTS ${VIEW}`)
      await adminRun(
        pg
          ? `CREATE VIEW ${VIEW} AS SELECT 'host=10.0.0.8 dbname=crm user=crm password=LiveConnPw1'::text AS conninfo, 'postgres://crm:LiveUrlPw2@10.0.0.8/crm'::text AS url`
          : `CREATE VIEW ${VIEW} AS SELECT 'host=10.0.0.8 user=crm password=LiveConnPw1' AS conninfo, 'mysql://fed:LiveUrlPw2@10.0.0.7:3306/crm/users' AS url`
      )
    })

    afterAll(async () => {
      if (!LIVE) return
      await engine?.shutdown()
      if (admin) {
        await adminRun(`DROP VIEW IF EXISTS ${VIEW}`).catch(() => undefined)
        await admin.close()
      }
    })

    itLive('the server DDL carries the credentials; the model reads them masked', async () => {
      const raw = await engine.ddl(id, ref)
      for (const secret of SECRETS) expect(raw).toContain(secret)

      const box = new AssistantToolbox({
        ctx: toolContext({
          dataProjectId: id,
          engine: target.engine,
          database: 'shop',
          schema: pg ? 'public' : undefined,
          service: engine
        }),
        emit: () => {}
      })
      const result = await box.call('get_table_ddl', { table: VIEW })
      expect(result.ok).toBe(true)
      expect(result.text).toContain(VIEW)
      for (const secret of SECRETS) expect(result.text).not.toContain(secret)
      expect(result.text).toContain('password=***')
      expect(result.text).toMatch(/:\/\/(crm|fed):\*\*\*@10\.0\.0\./)
    })
  })
}
