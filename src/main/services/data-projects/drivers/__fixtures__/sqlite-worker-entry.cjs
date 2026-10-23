// Fork target for sqlite.test.ts: stands in for the server bundle (out/main/server.js), which
// runs the same loop when TEDOOO_DATA_SQLITE_WORKER=1. The TS worker loads through Node's
// built-in type stripping (the worker module only has `import type` + node: imports for that).
'use strict'

if (process.env.TEDOOO_DATA_SQLITE_WORKER !== '1') {
  process.stderr.write('sqlite-worker-entry: TEDOOO_DATA_SQLITE_WORKER is not set\n')
  process.exit(2)
}

require(require('node:path').join(__dirname, '..', 'sqlite-worker.ts')).runSqliteWorker()
