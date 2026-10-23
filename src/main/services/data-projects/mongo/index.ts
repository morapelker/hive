// MongoDB support for data projects (server side). Public surface:
//
//   createMongoDriver(input)          DataDriver for engine 'mongodb' (drivers/index.ts factory)
//   createMongoEngineService(deps)    MongoEngineService behind dataProjects.mongo.* RPCs
//   executeMongoShellStatement(...)   one parsed mongosh-style statement → driver calls
//   mongoExportStatement(source, fmt) the streamRows statement for exports (+ MONGO_EJSON_COLUMN)
//
// The mongosh grammar, classification and splitting live in shared/data-projects/mongo-shell
// (also used by the renderer). Nothing here evaluates user text: values are parsed by
// @mongodb-js/shell-bson-parser's allowlist evaluator and statements are mapped to driver calls.

export {
  createMongoDriver,
  MONGO_DEFAULT_READ_TIMEOUT_MS,
  type MongoDriver,
  type MongoOperationHandle
} from './driver'
export { createMongoEngineService, type MongoServiceDeps } from './service'
export { executeMongoShellStatement, raceWithAbort, type MongoExecContext } from './executor'
export {
  MONGO_EJSON_COLUMN,
  mongoExportStatement,
  parseMongoExportSpec,
  type MongoExportSpec
} from './export'
export { buildMongoClientConfig, MONGO_APP_NAME, type MongoClientConfig } from './connection'
export { summarizeExplain } from './explain'
export { analyzeMongoDocuments } from './schema'
export { loadMongoRuntime } from './runtime'
