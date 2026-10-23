// mongosh-style Shell support shared by the renderer (statement at cursor, READ/WRITE badge,
// lint, completion tables) and the server (execution). Pure TS over acorn: no eval, no vm, no
// BSON library — values are converted server-side with @mongodb-js/shell-bson-parser.

export { splitMongoShell, mongoStatementAtOffset, type MongoShellSpan } from './splitter'
export { maskMongoSecrets, isMongoSecretKey } from './mask'
export { lexShell, stringTokenValue, type ShellToken, type ShellTokenType } from './shell-lexer'
export {
  parseMongoShell,
  parseMongoShellStructure,
  isMongoShellParseError,
  mongoPropertyKey,
  skipMongoTrivia,
  type MongoShellArgNode,
  type MongoShellKind,
  type MongoShellModifier,
  type MongoShellParsed,
  type MongoShellParseError,
  type MongoShellParseResult,
  type MongoShellRange,
  type MongoShellStructure
} from './parser'
export {
  classifyMongoShellStatement,
  classifyMongoCommand,
  classifyParsedMongoShell,
  type MongoClassifyContext,
  type MongoShellClassification
} from './classifier'
export {
  MONGO_DANGER,
  MONGO_OUTPUT_STAGES,
  MONGO_SERVER_JS_OPERATORS,
  findMongoOutputStages,
  findMongoServerJs,
  isEmptyMongoFilter,
  isPlainMongoObject,
  pipelineEndsWithOutput,
  type MongoOutputStage
} from './analysis'
export {
  MONGO_ADMIN_COMMANDS,
  MONGO_COLLECTION_METHODS,
  MONGO_CURSOR_METHODS,
  MONGO_DATABASE_METHODS,
  MONGO_DATABASE_NAVIGATION_METHODS,
  MONGO_DDL_COMMANDS,
  MONGO_EXPLAINABLE_METHODS,
  MONGO_EXPLAIN_VERBOSITIES,
  MONGO_READ_COMMANDS,
  MONGO_SHELL_CONSTRUCTORS,
  MONGO_SHOW_TARGETS,
  MONGO_WRITE_COMMANDS,
  type MongoArgRole,
  type MongoCursorMethodInfo,
  type MongoMethodInfo,
  type MongoMethodOutput
} from './methods'
