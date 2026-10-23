// `dataProjects.*` RPC domain: database connections in the sidebar (renderer client:
// src/renderer/src/api/data-projects-api.ts, contract: src/shared/data-projects/types.ts).
//
// Thin, strict layer over three things:
//   - the repository (DatabaseService: rows, history, saved queries) for CRUD,
//   - the secrets vault (main/services/data-projects/secrets.ts) for credentials,
//   - the DataEngineService (engine-service.ts) for everything that talks to a database. The
//     engine and its drivers are imported on first use only, so server start stays light; a
//     server that never opens a data project never loads mysql2/pg/mongodb.
//
// Every method is desktop-only. Device principals (phones, peer Macs) are refused here with
// DATA_FORBIDDEN on top of the remote-access policy's default deny (no `dataProjects.*` entry
// in shared/remote-access/policy.ts, and remote-policy.test.ts fails if one is ever added).
//
// Params are parsed with `.strict()` zod schemas that mirror the TS request types, with size
// caps on every free-text field. Failures leave as RpcRouteError with a DATA_ERROR_CODES code
// (validation → DATA_INVALID_INPUT) and a sanitized message: known secrets of the project, the
// secrets in the request itself, `scheme://user:pass@` and `password=` parameters are redacted,
// and `details` only ever carries a small object of primitives built here — never a driver
// error, a config object or the request.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Effect } from 'effect'
import { z } from 'zod'
import { getDatabase } from '../../../main/db'
import {
  DataDriverError,
  type DataCallContext,
  type DataEngineService,
  type DataProjectRecord,
  type DataProjectRecordPatch,
  type DataProjectsRepository
} from '../../../main/services/data-projects/contracts'
import {
  showDataOpenDialog,
  showDataSaveDialog
} from '../../../main/services/data-projects/desktop-dialogs'
import {
  getDataSecretsStore,
  normalizeDataSecrets,
  toDataProjectDto,
  type DataSecretsVault
} from '../../../main/services/data-projects/secrets'
import { redactSecrets } from '../../../main/services/data-projects/redact'
import { createLogger } from '../../../main/services/logger'
import {
  DATA_ENGINES,
  DATA_ENVIRONMENT_DEFAULTS,
  DATA_ENVIRONMENTS,
  DATA_ERROR_CODES,
  DATA_FILTER_OPERATORS,
  DATA_HARD_ROW_CAP,
  DATA_OBJECT_KINDS,
  DATA_SAFE_MODES,
  DATA_SSL_MODES,
  DEFAULT_DATA_ROW_LIMIT,
  type DataApplyEditsRequest,
  type DataCell,
  type DataConnectionConfig,
  type DataConnectionStatus,
  type DataEngine,
  type DataEnvironment,
  type DataExportRequest,
  type DataFilter,
  type DataHistoryEntry,
  type DataObjectRef,
  type DataParseConnectionUrlResult,
  type DataProject,
  type DataProjectCreateInput,
  type DataProjectIcon,
  type DataProjectUpdateInput,
  type DataQueryRequest,
  type DataRowEdit,
  type DataSavedQuery,
  type DataSecrets,
  type DataSecretsPatch,
  type DataSort,
  type DataTableRowsRequest,
  type DataTestConnectionInput,
  type MongoAggregateRequest,
  type MongoCollectionMutationRequest,
  type MongoCreateIndexRequest,
  type MongoDropIndexRequest,
  type MongoExplainRequest,
  type MongoFindRequest,
  type MongoSchemaRequest,
  type MongoWriteRequest,
  type SidebarOrderEntry
} from '../../../shared/data-projects/types'
import {
  DATA_IMPORT_ENCODINGS,
  DATA_IMPORT_FORMATS,
  DATA_IMPORT_MAX_BATCH_ROWS,
  DATA_IMPORT_MAX_PREVIEW_ROWS,
  MONGO_IMPORT_TYPES,
  type DataImportPreviewRequest,
  type DataImportStartRequest
} from '../../../shared/data-projects/import-types'
import { RPC_ERROR_CODES, RpcRouteError } from '../../../shared/rpc/errors'
import type { EventBus } from '../../events/event-bus'
import { getRpcRequestContext } from '../request-context'
import type { RpcHandler } from '../router'

const log = createLogger({ component: 'DataProjectsRpc' })

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

const KB = 1024
const MB = 1024 * KB
/** SQL scripts / mongosh text sent for execution (migrations can be several MB). */
const MAX_QUERY_TEXT = 16 * MB
/** Mongo documents (16 MB is MongoDB's own document cap) and update specs. */
const MAX_MONGO_DOCUMENT = 16 * MB
/** Filters, projections, sorts, pipelines, index specs. */
const MAX_MONGO_SPEC = 1 * MB
/** Renderer-built CSV/JSON saved through files.saveText. */
export const DATA_SAVE_TEXT_MAX_BYTES = 200 * MB
const MAX_ROW_EDITS = 10_000

// ---------------------------------------------------------------------------------------------
// Schemas (strict mirrors of src/shared/data-projects/types.ts)
// ---------------------------------------------------------------------------------------------

const idSchema = z.string().min(1).max(128)
const clientIdSchema = z.string().min(1).max(128)
const nameSchema = z.string().trim().min(1, 'Name is required').max(200)
const pathSchema = z.string().max(4096)
const hostSchema = z.string().max(1024)
const portSchema = z.number().int().min(1).max(65_535)
const identifierSchema = z.string().max(1024)
const secretValueSchema = z.string().max(4096)
const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Invalid colour')
const engineSchema = z.enum(DATA_ENGINES)
const limitSchema = z.number().int().min(0).max(DATA_HARD_ROW_CAP)
const timeoutMsSchema = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60 * 1000)

/** Extra URL/driver options are never secrets: anything that looks like one is dropped. */
const SECRET_OPTION_KEY = /pass|pwd|secret|token|credential|private.?key/i

const sslSchema = z
  .object({
    mode: z.enum(DATA_SSL_MODES),
    caPath: pathSchema.optional(),
    certPath: pathSchema.optional(),
    keyPath: pathSchema.optional()
  })
  .strict()

const sshSchema = z
  .object({
    enabled: z.boolean(),
    host: hostSchema,
    port: portSchema,
    username: z.string().max(256),
    authMethod: z.enum(['password', 'privateKey', 'agent']),
    privateKeyPath: pathSchema.optional()
  })
  .strict()

const mongoConfigSchema = z
  .object({
    srv: z.boolean(),
    hosts: z.array(hostSchema).max(64),
    authSource: z.string().max(256).optional(),
    authMechanism: z.string().max(64).optional(),
    replicaSet: z.string().max(256).optional(),
    directConnection: z.boolean().optional(),
    tls: z.boolean().optional(),
    tlsAllowInvalidCertificates: z.boolean().optional(),
    readPreference: z.string().max(64).optional()
  })
  .strict()

const configSchema: z.ZodType<DataConnectionConfig> = z
  .object({
    host: hostSchema.optional(),
    port: portSchema.optional(),
    database: identifierSchema.optional(),
    user: z.string().max(1024).optional(),
    ssl: sslSchema.optional(),
    filePath: pathSchema.optional(),
    readOnlyFile: z.boolean().optional(),
    mongo: mongoConfigSchema.optional(),
    clickhouseProtocol: z.enum(['http', 'https']).optional(),
    options: z
      .record(z.string().min(1).max(256), z.string().max(4096))
      .refine((value) => Object.keys(value).length <= 64, 'Too many options')
      .transform((value) =>
        Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_OPTION_KEY.test(key)))
      )
      .optional(),
    ssh: sshSchema.optional(),
    timezone: z.string().max(64).optional(),
    queryTimeoutMs: timeoutMsSchema.optional()
  })
  .strict()

const secretsSchema: z.ZodType<DataSecrets> = z
  .object({
    password: secretValueSchema.optional(),
    sshPassword: secretValueSchema.optional(),
    sshPassphrase: secretValueSchema.optional()
  })
  .strict()

const secretsPatchSchema: z.ZodType<DataSecretsPatch> = z
  .object({
    password: secretValueSchema.nullable().optional(),
    sshPassword: secretValueSchema.nullable().optional(),
    sshPassphrase: secretValueSchema.nullable().optional()
  })
  .strict()

const iconSchema: z.ZodType<DataProjectIcon> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('engine'), engine: engineSchema }).strict(),
  z.object({ kind: z.literal('emoji'), emoji: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal('lucide'), name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict(),
  z
    .object({
      kind: z.literal('image'),
      // A file name under ~/.hive/project-icons, never a path.
      fileName: z
        .string()
        .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/, 'Invalid icon file name')
        .refine((value) => !value.includes('..'), 'Invalid icon file name')
    })
    .strict()
])

const createInputSchema: z.ZodType<DataProjectCreateInput> = z
  .object({
    name: nameSchema,
    engine: engineSchema,
    config: configSchema,
    secrets: secretsSchema.optional(),
    icon: iconSchema.nullable().optional(),
    iconColor: hexColorSchema.nullable().optional(),
    environment: z.enum(DATA_ENVIRONMENTS).optional(),
    color: hexColorSchema.nullable().optional(),
    safeMode: z.enum(DATA_SAFE_MODES).optional(),
    defaultLimit: limitSchema.optional(),
    allowAiDataAccess: z.boolean().optional(),
    pinned: z.boolean().optional()
  })
  .strict()

const updateInputSchema: z.ZodType<DataProjectUpdateInput> = z
  .object({
    name: nameSchema.optional(),
    config: configSchema.optional(),
    secrets: secretsPatchSchema.optional(),
    icon: iconSchema.nullable().optional(),
    iconColor: hexColorSchema.nullable().optional(),
    environment: z.enum(DATA_ENVIRONMENTS).optional(),
    color: hexColorSchema.nullable().optional(),
    safeMode: z.enum(DATA_SAFE_MODES).optional(),
    defaultLimit: limitSchema.optional(),
    allowAiDataAccess: z.boolean().optional(),
    pinned: z.boolean().optional()
  })
  .strict()

const objectRefSchema: z.ZodType<DataObjectRef> = z
  .object({
    database: identifierSchema.optional(),
    schema: identifierSchema.optional(),
    name: z.string().min(1).max(1024),
    kind: z.enum(DATA_OBJECT_KINDS).optional()
  })
  .strict()

const cellSchema: z.ZodType<DataCell> = z.union([
  z.string().max(MAX_MONGO_DOCUMENT),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .object({
      $t: z.literal('bin'),
      hex: z.string().regex(/^[0-9a-fA-F]*$/),
      len: z.number().int().min(0)
    })
    .strict()
])

const cellRecordSchema = z
  .record(z.string().min(1).max(1024), cellSchema)
  .refine((value) => Object.keys(value).length <= 4096, 'Too many columns')

const rowEditSchema: z.ZodType<DataRowEdit> = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('update'), key: cellRecordSchema, changes: cellRecordSchema })
    .strict(),
  z.object({ kind: z.literal('insert'), values: cellRecordSchema }).strict(),
  z.object({ kind: z.literal('delete'), key: cellRecordSchema }).strict()
])

const filterSchema: z.ZodType<DataFilter> = z
  .object({
    column: z.string().min(1).max(1024),
    operator: z.enum(DATA_FILTER_OPERATORS),
    value: z
      .string()
      .max(64 * KB)
      .optional()
  })
  .strict()

const sortSchema: z.ZodType<DataSort> = z
  .object({ column: z.string().min(1).max(1024), direction: z.enum(['asc', 'desc']) })
  .strict()

const confirmTokenSchema = z.string().min(1).max(512)

const queryRequestSchema: z.ZodType<DataQueryRequest> = z
  .object({
    dataProjectId: idSchema,
    queryId: clientIdSchema,
    text: z.string().max(MAX_QUERY_TEXT),
    database: identifierSchema.optional(),
    schema: identifierSchema.optional(),
    limit: limitSchema.nullable(),
    confirmToken: confirmTokenSchema.optional(),
    source: z.enum(['editor', 'table', 'grid-edit', 'mongo', 'schema-action']),
    stopOnError: z.boolean().optional()
  })
  .strict()

const tableRowsRequestSchema: z.ZodType<DataTableRowsRequest> = z
  .object({
    dataProjectId: idSchema,
    queryId: clientIdSchema,
    ref: objectRefSchema,
    filters: z.array(filterSchema).max(200).optional(),
    filterJoin: z.enum(['and', 'or']).optional(),
    where: z
      .string()
      .max(64 * KB)
      .optional(),
    orderBy: z.array(sortSchema).max(32).optional(),
    limit: z.number().int().min(1).max(DATA_HARD_ROW_CAP),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const applyEditsRequestSchema: z.ZodType<DataApplyEditsRequest> = z
  .object({
    dataProjectId: idSchema,
    ref: objectRefSchema,
    edits: z.array(rowEditSchema).min(1).max(MAX_ROW_EDITS),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const absolutePathSchema = pathSchema.refine((value) => isAbsolute(value), 'Path must be absolute')

const exportRequestSchema: z.ZodType<DataExportRequest> = z
  .object({
    dataProjectId: idSchema,
    exportId: clientIdSchema,
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('table'),
          ref: objectRefSchema,
          filters: z.array(filterSchema).max(200).optional(),
          filterJoin: z.enum(['and', 'or']).optional(),
          where: z
            .string()
            .max(64 * KB)
            .optional(),
          orderBy: z.array(sortSchema).max(32).optional()
        })
        .strict(),
      z
        .object({
          kind: z.literal('query'),
          text: z.string().min(1).max(MAX_QUERY_TEXT),
          database: identifierSchema.optional(),
          schema: identifierSchema.optional()
        })
        .strict(),
      z
        .object({
          kind: z.literal('mongo'),
          database: z.string().min(1).max(1024),
          collection: z.string().min(1).max(1024),
          filter: z.string().max(MAX_MONGO_SPEC).optional(),
          projection: z.string().max(MAX_MONGO_SPEC).optional(),
          sort: z.string().max(MAX_MONGO_SPEC).optional(),
          collation: z.string().max(MAX_MONGO_SPEC).optional(),
          hint: z.string().max(MAX_MONGO_SPEC).optional(),
          pipeline: z.string().max(MAX_MONGO_SPEC).optional()
        })
        .strict()
    ]),
    format: z.enum(['csv', 'json', 'sql']),
    filePath: absolutePathSchema.optional(),
    csv: z
      .object({
        delimiter: z.enum([',', ';', '\t']).optional(),
        header: z.boolean().optional()
      })
      .strict()
      .optional(),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

// Import (dataProjects.import.*): the file is read by the server from a local absolute path.
const importTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), ref: objectRefSchema }).strict(),
  z
    .object({
      kind: z.literal('collection'),
      database: z.string().min(1).max(1024),
      collection: z.string().min(1).max(1024)
    })
    .strict()
])
const importQuoteSchema = z.enum(['"', "'", ''])
const importDelimiterSchema = z.string().length(1)

const importPreviewRequestSchema: z.ZodType<DataImportPreviewRequest> = z
  .object({
    dataProjectId: idSchema,
    filePath: absolutePathSchema,
    target: importTargetSchema,
    format: z.enum(DATA_IMPORT_FORMATS).optional(),
    encoding: z.enum(DATA_IMPORT_ENCODINGS).optional(),
    csv: z
      .object({
        delimiter: importDelimiterSchema.optional(),
        quote: importQuoteSchema.optional(),
        header: z.boolean().optional()
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(DATA_IMPORT_MAX_PREVIEW_ROWS).optional()
  })
  .strict()

const importStartRequestSchema: z.ZodType<DataImportStartRequest> = z
  .object({
    dataProjectId: idSchema,
    importId: clientIdSchema,
    filePath: absolutePathSchema,
    target: importTargetSchema,
    format: z.enum(DATA_IMPORT_FORMATS),
    encoding: z.enum(DATA_IMPORT_ENCODINGS),
    csv: z
      .object({
        delimiter: importDelimiterSchema,
        quote: importQuoteSchema,
        header: z.boolean()
      })
      .strict()
      .optional(),
    columns: z
      .array(
        z
          .object({
            source: z.number().int().min(0).max(100_000),
            target: z.string().min(1).max(1024),
            type: z.enum(MONGO_IMPORT_TYPES).optional()
          })
          .strict()
      )
      .max(16_384)
      .optional(),
    empty: z.enum(['null', 'empty', 'omit']),
    onError: z.enum(['rollback', 'stop', 'skip']),
    batchSize: z.number().int().min(1).max(DATA_IMPORT_MAX_BATCH_ROWS).optional(),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const mongoNameSchema = z.string().min(1).max(1024)
const mongoSpecSchema = z.string().max(MAX_MONGO_SPEC)
const maxTimeMsSchema = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60 * 1000)

const mongoFindRequestSchema: z.ZodType<MongoFindRequest> = z
  .object({
    dataProjectId: idSchema,
    queryId: clientIdSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    filter: mongoSpecSchema.optional(),
    projection: mongoSpecSchema.optional(),
    sort: mongoSpecSchema.optional(),
    collation: mongoSpecSchema.optional(),
    hint: mongoSpecSchema.optional(),
    skip: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: limitSchema,
    maxTimeMS: maxTimeMsSchema.optional(),
    withCount: z.boolean().optional()
  })
  .strict()

const mongoAggregateRequestSchema: z.ZodType<MongoAggregateRequest> = z
  .object({
    dataProjectId: idSchema,
    queryId: clientIdSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    pipeline: mongoSpecSchema,
    stageIndex: z.number().int().min(0).max(1000).optional(),
    limit: limitSchema,
    maxTimeMS: maxTimeMsSchema.optional(),
    allowDiskUse: z.boolean().optional(),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const mongoWriteRequestSchema: z.ZodType<MongoWriteRequest> = z
  .object({
    dataProjectId: idSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    op: z.enum([
      'insertOne',
      'insertMany',
      'replaceOne',
      'updateOne',
      'updateMany',
      'deleteOne',
      'deleteMany'
    ]),
    filter: mongoSpecSchema.optional(),
    document: z.string().max(MAX_MONGO_DOCUMENT).optional(),
    update: z.string().max(MAX_MONGO_DOCUMENT).optional(),
    upsert: z.boolean().optional(),
    collation: mongoSpecSchema.optional(),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const mongoCreateIndexRequestSchema: z.ZodType<MongoCreateIndexRequest> = z
  .object({
    dataProjectId: idSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    keys: z.string().min(1).max(MAX_MONGO_SPEC),
    options: mongoSpecSchema.optional(),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const mongoDropIndexRequestSchema: z.ZodType<MongoDropIndexRequest> = z
  .object({
    dataProjectId: idSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    name: z.string().min(1).max(1024),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const mongoSchemaRequestSchema: z.ZodType<MongoSchemaRequest> = z
  .object({
    dataProjectId: idSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    sampleSize: z.number().int().min(1).max(100_000).optional()
  })
  .strict()

const mongoExplainRequestSchema: z.ZodType<MongoExplainRequest> = z
  .object({
    dataProjectId: idSchema,
    database: mongoNameSchema,
    collection: mongoNameSchema,
    find: z
      .object({
        filter: mongoSpecSchema.optional(),
        projection: mongoSpecSchema.optional(),
        sort: mongoSpecSchema.optional(),
        collation: mongoSpecSchema.optional(),
        hint: mongoSpecSchema.optional(),
        skip: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: limitSchema
      })
      .strict()
      .optional(),
    pipeline: mongoSpecSchema.optional()
  })
  .strict()

const mongoCollectionRequestSchema: z.ZodType<MongoCollectionMutationRequest> = z
  .object({
    dataProjectId: idSchema,
    database: mongoNameSchema,
    action: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('create'),
          collection: mongoNameSchema,
          options: mongoSpecSchema.optional()
        })
        .strict(),
      z.object({ kind: z.literal('drop'), collection: mongoNameSchema }).strict(),
      z
        .object({ kind: z.literal('rename'), collection: mongoNameSchema, to: mongoNameSchema })
        .strict(),
      z.object({ kind: z.literal('dropDatabase') }).strict()
    ]),
    confirmToken: confirmTokenSchema.optional()
  })
  .strict()

const testConnectionInputSchema: z.ZodType<DataTestConnectionInput> = z
  .object({
    engine: engineSchema,
    config: configSchema,
    secrets: secretsSchema.optional(),
    dataProjectId: idSchema.optional()
  })
  .strict()

const savedQueryInputSchema = z
  .object({
    id: idSchema.optional(),
    name: nameSchema,
    text: z.string().max(MAX_QUERY_TEXT),
    database: identifierSchema.nullable().optional()
  })
  .strict()

const sidebarEntrySchema: z.ZodType<SidebarOrderEntry> = z
  .object({ kind: z.enum(['project', 'data']), id: idSchema })
  .strict()

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const byIdSchema = z.object({ id: idSchema }).strict()

const params = {
  list: emptyParamsSchema,
  byId: byIdSchema,
  create: z.object({ input: createInputSchema }).strict(),
  update: z.object({ id: idSchema, patch: updateInputSchema }).strict(),
  reorderSidebar: z
    .object({
      entries: z
        .array(sidebarEntrySchema)
        .max(10_000)
        .refine(
          (entries) =>
            new Set(entries.map((entry) => `${entry.kind}:${entry.id}`)).size === entries.length,
          'Duplicate sidebar entries'
        )
    })
    .strict(),
  parseUrl: z.object({ url: z.string().max(8 * KB), engineHint: engineSchema.optional() }).strict(),
  testConnection: z.object({ input: testConnectionInputSchema }).strict(),
  provideSessionSecrets: z
    .object({ id: idSchema, secrets: secretsSchema, remember: z.boolean() })
    .strict(),
  objects: z
    .object({
      id: idSchema,
      database: identifierSchema.optional(),
      schema: identifierSchema.optional()
    })
    .strict(),
  ref: z.object({ id: idSchema, ref: objectRefSchema }).strict(),
  completion: z
    .object({
      id: idSchema,
      database: identifierSchema.optional(),
      refresh: z.boolean().optional()
    })
    .strict(),
  cancelQuery: z.object({ queryId: clientIdSchema }).strict(),
  previewEdits: z
    .object({
      id: idSchema,
      ref: objectRefSchema,
      edits: z.array(rowEditSchema).max(MAX_ROW_EDITS)
    })
    .strict(),
  kill: z
    .object({
      id: idSchema,
      processId: z.string().min(1).max(256),
      scope: z.enum(['query', 'connection'])
    })
    .strict(),
  cancelExport: z.object({ exportId: clientIdSchema }).strict(),
  cancelImport: z.object({ importId: clientIdSchema }).strict(),
  saveText: z
    .object({
      defaultName: z.string().min(1).max(255),
      content: z.string().max(DATA_SAVE_TEXT_MAX_BYTES),
      extensions: z.array(z.string().max(16)).max(16)
    })
    .strict(),
  pickFile: z
    .object({
      purpose: z.enum(['sqlite', 'certificate', 'ssh-key']),
      allowCreate: z.boolean().optional()
    })
    .strict(),
  history: z
    .object({
      id: idSchema,
      search: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(1000).optional()
    })
    .strict(),
  saveQuery: z.object({ id: idSchema, query: savedQueryInputSchema }).strict(),
  deleteSavedQuery: z.object({ id: idSchema, savedId: idSchema }).strict(),
  mongoIndexes: z
    .object({ id: idSchema, database: mongoNameSchema, collection: mongoNameSchema })
    .strict()
} as const

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const DATA_CODES: ReadonlySet<string> = new Set(Object.values(DATA_ERROR_CODES))
const MAX_ERROR_MESSAGE = 4000

const dataError = (
  code: string,
  message: string,
  details?: Record<string, unknown>
): RpcRouteError => new RpcRouteError(code, message, details)

const notFound = (id: string): RpcRouteError =>
  dataError(DATA_ERROR_CODES.notFound, 'Data project not found', { dataProjectId: id })

const invalidInput = (message: string): RpcRouteError =>
  dataError(DATA_ERROR_CODES.invalidInput, message)

/**
 * Removes credentials from a text bound for the renderer or the log (engine-core's
 * `redactSecrets`: every known secret, `scheme://user:pass@` userinfo, `password=` pairs) and
 * caps its length.
 */
export const redactDataText = (text: string, secrets: readonly string[] = []): string => {
  const result = redactSecrets(text, secrets)
  return result.length > MAX_ERROR_MESSAGE ? `${result.slice(0, MAX_ERROR_MESSAGE)}…` : result
}

/** Keeps a details object only when it is a flat record of primitives (strings redacted). */
const safeDetails = (
  details: unknown,
  secrets: readonly string[]
): Record<string, string | number | boolean | null> | undefined => {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(details).slice(0, 16)) {
    if (typeof value === 'string') out[key] = redactDataText(value, secrets).slice(0, 1000)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const describeZodError = (error: z.ZodError): string => {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  const more = error.issues.length > 5 ? ` (+${error.issues.length - 5} more)` : ''
  return `Invalid input: ${parts.join('; ')}${more}`
}

const errorCodeOf = (cause: unknown): string | null => {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' && DATA_CODES.has(code) ? code : null
}

/** Any failure → RpcRouteError with a DATA_* (or INTERNAL_ERROR) code and a redacted message. */
export const toDataRpcError = (cause: unknown, secrets: readonly string[] = []): RpcRouteError => {
  if (cause instanceof z.ZodError) return invalidInput(describeZodError(cause))
  if (cause instanceof RpcRouteError) {
    return dataError(
      cause.code,
      redactDataText(cause.message, secrets),
      safeDetails(cause.details, secrets)
    )
  }
  if (cause instanceof DataDriverError) {
    const details = safeDetails(
      {
        driverCode: cause.code ?? null,
        position: cause.position ?? null,
        hint: cause.hint ?? null,
        cancelled: cause.cancelled
      },
      secrets
    )
    return dataError(RPC_ERROR_CODES.internalError, redactDataText(cause.message, secrets), details)
  }
  const code = errorCodeOf(cause)
  if (cause instanceof Error) {
    return dataError(code ?? RPC_ERROR_CODES.internalError, redactDataText(cause.message, secrets))
  }
  return dataError(code ?? RPC_ERROR_CODES.internalError, 'Unexpected data project failure')
}

/** Secrets carried by the request itself (create / update / test / provide), for redaction. */
const secretsInParams = (raw: unknown): string[] => {
  const found: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    for (const key of ['password', 'sshPassword', 'sshPassphrase']) {
      const secret = (value as Record<string, unknown>)[key]
      if (typeof secret === 'string' && secret.length > 0) found.push(secret)
    }
  }
  if (typeof raw !== 'object' || raw === null) return found
  const record = raw as Record<string, unknown>
  collect(record.secrets)
  collect((record.input as Record<string, unknown> | undefined)?.secrets)
  collect((record.patch as Record<string, unknown> | undefined)?.secrets)
  return found
}

const projectIdInParams = (raw: unknown): string | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  for (const candidate of [
    record.id,
    record.dataProjectId,
    (record.input as Record<string, unknown> | undefined)?.dataProjectId
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128) {
      return candidate
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export type DataFilePurpose = 'sqlite' | 'certificate' | 'ssh-key'

export interface DataProjectsRpcService {
  readonly list: () => Promise<DataProject[]>
  readonly get: (id: string) => Promise<DataProject | null>
  readonly create: (input: DataProjectCreateInput) => Promise<DataProject>
  readonly update: (id: string, patch: DataProjectUpdateInput) => Promise<DataProject>
  readonly delete: (id: string) => Promise<{ success: boolean }>
  readonly touch: (id: string) => Promise<void>
  readonly reorderSidebar: (entries: SidebarOrderEntry[]) => Promise<void>
  readonly duplicate: (id: string) => Promise<DataProject>
  readonly parseUrl: (url: string, engineHint?: DataEngine) => Promise<DataParseConnectionUrlResult>
  readonly provideSessionSecrets: (
    id: string,
    secrets: DataSecrets,
    remember: boolean
  ) => Promise<DataProject>
  readonly history: (id: string, search?: string, limit?: number) => Promise<DataHistoryEntry[]>
  readonly clearHistory: (id: string) => Promise<void>
  readonly savedQueries: (id: string) => Promise<DataSavedQuery[]>
  readonly saveQuery: (
    id: string,
    query: { id?: string; name: string; text: string; database?: string | null }
  ) => Promise<DataSavedQuery>
  readonly deleteSavedQuery: (id: string, savedId: string) => Promise<void>
  readonly saveTextFile: (
    defaultName: string,
    content: string,
    extensions: string[]
  ) => Promise<{ filePath: string | null }>
  readonly pickFile: (
    purpose: DataFilePurpose,
    allowCreate?: boolean
  ) => Promise<{ filePath: string | null }>
  readonly status: (id: string) => Promise<DataConnectionStatus>
  readonly disconnect: (id: string) => Promise<DataConnectionStatus>
  readonly cancelQuery: (queryId: string) => Promise<{ cancelled: boolean }>
  readonly cancelExport: (exportId: string) => Promise<{ cancelled: boolean }>
  /** The engine, imported and created on first use. */
  readonly engine: () => Promise<DataEngineService>
  /** The engine when something already loaded it, else null (nothing can be connected). */
  readonly loadedEngine: () => DataEngineService | null
  /** Every secret currently known for a project (error redaction). */
  readonly knownSecrets: (id: string) => string[]
  /** A renderer socket closed: cancel its queries / exports. No-op until the engine loaded. */
  readonly releaseClient: (clientId: string) => void
  /** Server shutdown: close every connection. No-op until the engine loaded. */
  readonly shutdown: () => Promise<void>
}

export interface DataProjectIconFiles {
  /** Deletes `~/.hive/project-icons/<dataProjectId>.*`. */
  readonly remove: (dataProjectId: string) => Promise<void>
  /** Copies an icon file for a duplicate; the new file name, or null when it cannot. */
  readonly copy: (fileName: string, toDataProjectId: string) => Promise<string | null>
}

export interface DataProjectsRpcDeps {
  /** Engine status / export events are published on it (setDataEnginePublisher). */
  readonly eventBus?: EventBus
  readonly repository?: () => DataProjectsRepository
  readonly secrets?: () => DataSecretsVault
  readonly loadEngine?: () => Promise<DataEngineService>
  readonly showSaveDialog?: (input: {
    defaultName: string
    extensions: string[]
  }) => Promise<string | null>
  readonly showOpenDialog?: (input: {
    purpose: DataFilePurpose
    allowCreate?: boolean
  }) => Promise<string | null>
  readonly parseConnectionUrl?: (
    url: string,
    engineHint?: DataEngine
  ) => DataParseConnectionUrlResult | Promise<DataParseConnectionUrlResult>
  readonly icons?: DataProjectIconFiles
  readonly writeTextFile?: (filePath: string, content: string) => Promise<void>
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  'host.docker.internal'
])

/** Environment when the wizard sent none: a local file or loopback host is 'local'. */
const defaultEnvironmentFor = (
  engine: DataEngine,
  config: DataConnectionConfig
): DataEnvironment => {
  if (engine === 'sqlite') return 'local'
  const host = (config.host ?? config.mongo?.hosts[0]?.split(':')[0] ?? '').trim().toLowerCase()
  return LOCAL_HOSTS.has(host) ? 'local' : 'development'
}

/** The minimum a connection needs; everything else is the driver's to judge. */
const assertConnectable = (engine: DataEngine, config: DataConnectionConfig): void => {
  if (engine === 'sqlite') {
    if (!config.filePath?.trim()) throw invalidInput('Choose the SQLite database file')
    return
  }
  const hasHost =
    Boolean(config.host?.trim()) ||
    (engine === 'mongodb' && (config.mongo?.hosts ?? []).some((host) => host.trim().length > 0))
  if (!hasHost) throw invalidInput('Host is required')
  if (config.ssh?.enabled && (!config.ssh.host.trim() || !config.ssh.username.trim())) {
    throw invalidInput('SSH tunnel host and user are required')
  }
}

const hasSecrets = (secrets: DataSecrets): boolean => Object.keys(secrets).length > 0

const copyName = (name: string): string => {
  const suffix = ' copy'
  return `${name.slice(0, 200 - suffix.length)}${suffix}`
}

const projectIconDir = (): string => join(homedir(), '.hive', 'project-icons')

const defaultIconFiles: DataProjectIconFiles = {
  remove: async (dataProjectId) => {
    const { removeProjectIcon } = await import('../../../main/services/project-icons')
    removeProjectIcon(dataProjectId, projectIconDir())
  },
  copy: async (fileName, toDataProjectId) => {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(fileName) || fileName.includes('..')) return null
    const source = join(projectIconDir(), fileName)
    if (!existsSync(source)) return null
    const { saveProjectIcon } = await import('../../../main/services/project-icons')
    const result = saveProjectIcon(toDataProjectId, source, projectIconDir())
    return result.success && result.filename ? result.filename : null
  }
}

/** Write next to the target, then rename: a crash never leaves a half-written export behind. */
const writeTextFileAtomic = async (filePath: string, content: string): Promise<void> => {
  const temp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`)
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o644 })
    await rename(temp, filePath)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    const code = (error as NodeJS.ErrnoException | null)?.code
    throw new Error(`Could not write ${basename(filePath)}${code ? ` (${code})` : ''}`)
  }
}

const loadLiveEngine = async (eventBus: EventBus | undefined): Promise<DataEngineService> => {
  const engineModule = await import('../../../main/services/data-projects/engine-service')
  if (eventBus) {
    engineModule.setDataEnginePublisher((channel, payload) => {
      try {
        void Effect.runPromise(eventBus.publish({ channel, payload })).catch(() => undefined)
      } catch {
        // A failing subscriber must never break the engine's own work.
      }
    })
  }
  return engineModule.getDataEngineService()
}

const loadParseConnectionUrl = async (
  url: string,
  engineHint?: DataEngine
): Promise<DataParseConnectionUrlResult> => {
  const { parseConnectionUrl } = await import('../../../shared/data-projects/connection-url')
  return parseConnectionUrl(url, engineHint)
}

export const makeLiveDataProjectsRpcService = (
  deps: DataProjectsRpcDeps = {}
): DataProjectsRpcService => {
  const repo = deps.repository ?? ((): DataProjectsRepository => getDatabase())
  const vault = deps.secrets ?? getDataSecretsStore
  const loadEngine = deps.loadEngine ?? (() => loadLiveEngine(deps.eventBus))
  const showSaveDialog = deps.showSaveDialog ?? showDataSaveDialog
  const showOpenDialog = deps.showOpenDialog ?? showDataOpenDialog
  const parseConnectionUrl = deps.parseConnectionUrl ?? loadParseConnectionUrl
  const icons = deps.icons ?? defaultIconFiles
  const writeTextFile = deps.writeTextFile ?? writeTextFileAtomic

  let enginePromise: Promise<DataEngineService> | null = null
  let engineInstance: DataEngineService | null = null

  const engine = (): Promise<DataEngineService> => {
    if (!enginePromise) {
      enginePromise = loadEngine().then(
        (loaded) => {
          engineInstance = loaded
          return loaded
        },
        (error: unknown) => {
          // Retry on the next call (e.g. a driver chunk that failed to load once).
          enginePromise = null
          throw error
        }
      )
    }
    return enginePromise
  }

  const dto = (record: DataProjectRecord): DataProject => toDataProjectDto(record, vault())

  const requireRecord = (id: string): DataProjectRecord => {
    const record = repo().getDataProject(id)
    if (!record) throw notFound(id)
    return record
  }

  /** Closes the project's connections and drops engine caches (only if the engine is loaded). */
  const invalidateEngine = async (id: string): Promise<void> => {
    if (!engineInstance) return
    try {
      await engineInstance.invalidate(id)
    } catch (error) {
      log.warn('Data project invalidate failed', {
        dataProjectId: id,
        error: redactDataText(error instanceof Error ? error.message : String(error))
      })
    }
  }

  /**
   * The secrets a patch merges into: the current ones when readable; {} when they cannot be
   * read (the user is re-entering credentials for a vault-locked project anyway).
   */
  const currentSecrets = async (record: DataProjectRecord): Promise<DataSecrets> => {
    if (vault().stateOf(record) === 'none') return {}
    try {
      return await vault().resolve(record.id)
    } catch {
      return {}
    }
  }

  return {
    list: async () => repo().getDataProjects().map(dto),

    get: async (id) => {
      const record = repo().getDataProject(id)
      return record ? dto(record) : null
    },

    create: async (input) => {
      assertConnectable(input.engine, input.config)
      const id = randomUUID()
      const secrets = normalizeDataSecrets(input.secrets)
      const stored = hasSecrets(secrets)
        ? await vault().store(id, secrets)
        : { ciphertext: null, state: 'none' as const }
      const environment = input.environment ?? defaultEnvironmentFor(input.engine, input.config)
      try {
        const record = repo().createDataProject({
          id,
          name: input.name.trim(),
          engine: input.engine,
          config: input.config,
          icon: input.icon ?? null,
          iconColor: input.iconColor ?? null,
          environment,
          color: input.color ?? null,
          safeMode: input.safeMode ?? DATA_ENVIRONMENT_DEFAULTS[environment].safeMode,
          defaultLimit: input.defaultLimit ?? DEFAULT_DATA_ROW_LIMIT,
          allowAiDataAccess: input.allowAiDataAccess ?? false,
          pinned: input.pinned ?? false,
          secretCiphertext: stored.ciphertext,
          secretState: stored.state
        })
        return dto(record)
      } catch (error) {
        vault().forget(id)
        throw error
      }
    },

    update: async (id, patch) => {
      const existing = requireRecord(id)
      const recordPatch: DataProjectRecordPatch = {}
      if (patch.name !== undefined) recordPatch.name = patch.name.trim()
      let configChanged = false
      if (patch.config !== undefined) {
        assertConnectable(existing.engine, patch.config)
        recordPatch.config = patch.config
        configChanged = JSON.stringify(patch.config) !== JSON.stringify(existing.config)
      }
      if (patch.icon !== undefined) recordPatch.icon = patch.icon
      if (patch.iconColor !== undefined) recordPatch.iconColor = patch.iconColor
      if (patch.environment !== undefined) recordPatch.environment = patch.environment
      if (patch.color !== undefined) recordPatch.color = patch.color
      if (patch.safeMode !== undefined) recordPatch.safeMode = patch.safeMode
      if (patch.defaultLimit !== undefined) recordPatch.defaultLimit = patch.defaultLimit
      if (patch.allowAiDataAccess !== undefined) {
        recordPatch.allowAiDataAccess = patch.allowAiDataAccess
      }
      if (patch.pinned !== undefined) recordPatch.pinned = patch.pinned

      const secretsPatch = patch.secrets
      const secretsChanged =
        secretsPatch !== undefined &&
        Object.values(secretsPatch).some((value) => value !== undefined)
      if (secretsChanged && secretsPatch) {
        const merged: DataSecrets = { ...(await currentSecrets(existing)) }
        for (const key of ['password', 'sshPassword', 'sshPassphrase'] as const) {
          const value = secretsPatch[key]
          if (value === null) delete merged[key]
          else if (value !== undefined) merged[key] = value
        }
        const normalized = normalizeDataSecrets(merged)
        if (hasSecrets(normalized)) {
          const stored = await vault().store(id, normalized)
          recordPatch.secretCiphertext = stored.ciphertext
          recordPatch.secretState = stored.state
        } else {
          vault().forget(id)
          recordPatch.secretCiphertext = null
          recordPatch.secretState = 'none'
        }
      }

      const updated = repo().updateDataProject(id, recordPatch)
      if (!updated) throw notFound(id)
      if (configChanged || secretsChanged) await invalidateEngine(id)
      // Switching away from an uploaded image leaves its file behind otherwise.
      if (
        existing.icon?.kind === 'image' &&
        patch.icon !== undefined &&
        patch.icon?.kind !== 'image'
      ) {
        await icons.remove(id).catch(() => undefined)
      }
      return dto(updated)
    },

    delete: async (id) => {
      const existing = repo().getDataProject(id)
      if (!existing) return { success: false }
      await invalidateEngine(id)
      vault().forget(id)
      const success = repo().deleteDataProject(id)
      if (existing.icon?.kind === 'image') await icons.remove(id).catch(() => undefined)
      // Free the deleted project's console entries (in-memory only).
      if (success) {
        await import('../../../main/services/data-projects/console-log')
          .then((m) => m.getDataConsoleLog().forget(id))
          .catch(() => undefined)
      }
      return { success }
    },

    touch: async (id) => {
      requireRecord(id)
      repo().touchDataProject(id)
    },

    reorderSidebar: async (entries) => {
      repo().reorderSidebar(entries)
    },

    duplicate: async (id) => {
      const source = requireRecord(id)
      const newId = randomUUID()
      let icon = source.icon
      if (icon?.kind === 'image') {
        const copied = await icons.copy(icon.fileName, newId).catch(() => null)
        icon = copied ? { kind: 'image', fileName: copied } : null
      }
      const session = vault().sessionSecretsOf(id)
      const record = repo().createDataProject({
        id: newId,
        name: copyName(source.name),
        engine: source.engine,
        config: source.config,
        icon,
        iconColor: source.iconColor,
        environment: source.environment,
        color: source.color,
        safeMode: source.safeMode,
        defaultLimit: source.defaultLimit,
        allowAiDataAccess: source.allowAiDataAccess,
        pinned: false,
        // The ciphertext is not bound to the project id: the copy decrypts the same blob.
        secretCiphertext: source.secretCiphertext,
        secretState: source.secretState
      })
      if (session) vault().remember(newId, session)
      return dto(record)
    },

    parseUrl: async (url, engineHint) => {
      try {
        return await parseConnectionUrl(url, engineHint)
      } catch (error) {
        return {
          ok: false,
          error: redactDataText(error instanceof Error ? error.message : 'Unrecognised URL')
        }
      }
    },

    provideSessionSecrets: async (id, secrets, remember) => {
      const record = requireRecord(id)
      const provided = normalizeDataSecrets(secrets)
      if (!hasSecrets(provided)) throw invalidInput('Enter the password')
      // Keep what is still known (e.g. an SSH passphrase) and override what was typed.
      const merged = normalizeDataSecrets({ ...(await currentSecrets(record)), ...provided })
      if (remember) {
        const stored = await vault().store(id, merged)
        if (stored.state === 'stored') {
          repo().updateDataProject(id, {
            secretCiphertext: stored.ciphertext,
            secretState: 'stored'
          })
        } else if (record.secretState === 'none') {
          // No vault reachable: memory only, and after a restart the UI asks again.
          repo().updateDataProject(id, { secretState: 'session' })
        }
      } else {
        vault().remember(id, merged)
        if (record.secretState === 'none') repo().updateDataProject(id, { secretState: 'session' })
      }
      await invalidateEngine(id)
      return dto(requireRecord(id))
    },

    history: async (id, search, limit) =>
      repo().listDataQueryHistory(id, {
        ...(search !== undefined ? { search } : {}),
        ...(limit !== undefined ? { limit } : {})
      }),

    clearHistory: async (id) => {
      repo().clearDataQueryHistory(id)
    },

    savedQueries: async (id) => repo().listDataSavedQueries(id),

    saveQuery: async (id, query) => {
      requireRecord(id)
      return repo().saveDataSavedQuery(id, {
        ...(query.id ? { id: query.id } : {}),
        name: query.name.trim(),
        text: query.text,
        database: query.database ?? null
      })
    },

    deleteSavedQuery: async (id, savedId) => {
      repo().deleteDataSavedQuery(id, savedId)
    },

    saveTextFile: async (defaultName, content, extensions) => {
      if (Buffer.byteLength(content, 'utf8') > DATA_SAVE_TEXT_MAX_BYTES) {
        throw invalidInput('The file is larger than 200 MB; use Export instead')
      }
      const filePath = await showSaveDialog({ defaultName, extensions })
      if (!filePath) return { filePath: null }
      await writeTextFile(filePath, content)
      return { filePath }
    },

    pickFile: async (purpose, allowCreate) => ({
      filePath: await showOpenDialog({ purpose, ...(allowCreate ? { allowCreate } : {}) })
    }),

    // Through the engine even when this service has not used it yet: the assistant may have
    // connected the project (the engine module itself loads no driver until one connects).
    status: async (id) => {
      requireRecord(id)
      return (await engine()).status(id)
    },

    disconnect: async (id) => {
      requireRecord(id)
      return (await engine()).disconnect(id)
    },

    // A query / export can only have started through this service, so nothing to cancel
    // before it loaded the engine.
    cancelQuery: async (queryId) =>
      engineInstance ? engineInstance.cancel(queryId) : { cancelled: false },

    cancelExport: async (exportId) =>
      engineInstance ? engineInstance.exportCancel(exportId) : { cancelled: false },

    engine,

    loadedEngine: () => engineInstance,

    knownSecrets: (id) => {
      try {
        return vault().knownSecrets(id)
      } catch {
        return []
      }
    },

    releaseClient: (clientId) => {
      if (!engineInstance) return
      try {
        engineInstance.releaseClient(clientId)
      } catch (error) {
        log.warn('Data engine releaseClient failed', {
          error: redactDataText(error instanceof Error ? error.message : String(error))
        })
      }
    },

    shutdown: async () => {
      const loaded = engineInstance
      engineInstance = null
      enginePromise = null
      if (!loaded) return
      await loaded.shutdown()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

const currentClientId = (): string | null => getRpcRequestContext()?.clientId ?? null

/** Data projects are desktop-only: phones and peer Macs are refused even if a policy slipped. */
const assertDesktopPrincipal = (): void => {
  const principal = getRpcRequestContext()?.principal ?? null
  if (principal && principal.kind === 'device') {
    throw dataError(
      DATA_ERROR_CODES.forbidden,
      'Data projects are not available from a remote device'
    )
  }
}

const parseParams = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw)
  if (!result.success) throw invalidInput(describeZodError(result.error))
  return result.data
}

export const makeDataProjectsRpcHandlers = (
  service: DataProjectsRpcService = makeLiveDataProjectsRpcService()
): ReadonlyMap<string, RpcHandler> => {
  const route =
    <T>(
      schema: z.ZodType<T>,
      run: (input: T, ctx: DataCallContext) => Promise<unknown>
    ): RpcHandler =>
    (raw) =>
      Effect.tryPromise({
        try: async () => {
          assertDesktopPrincipal()
          const input = parseParams(schema, raw)
          return await run(input, { clientId: currentClientId() })
        },
        catch: (cause) => {
          const projectId = projectIdInParams(raw)
          const secrets = [
            ...secretsInParams(raw),
            ...(projectId ? service.knownSecrets(projectId) : [])
          ]
          const error = toDataRpcError(cause, secrets)
          if (error.code === RPC_ERROR_CODES.internalError) {
            log.warn('Data project RPC failed', { message: error.message })
          }
          return error
        }
      })

  const withEngine = <T>(
    schema: z.ZodType<T>,
    run: (engine: DataEngineService, input: T, ctx: DataCallContext) => Promise<unknown>
  ): RpcHandler => route(schema, async (input, ctx) => run(await service.engine(), input, ctx))

  return new Map<string, RpcHandler>([
    // ---- CRUD ----------------------------------------------------------------------------------
    ['dataProjects.list', route(params.list, () => service.list())],
    ['dataProjects.get', route(params.byId, ({ id }) => service.get(id))],
    ['dataProjects.create', route(params.create, ({ input }) => service.create(input))],
    ['dataProjects.update', route(params.update, ({ id, patch }) => service.update(id, patch))],
    ['dataProjects.delete', route(params.byId, ({ id }) => service.delete(id))],
    ['dataProjects.touch', route(params.byId, ({ id }) => service.touch(id))],
    [
      'dataProjects.reorderSidebar',
      route(params.reorderSidebar, ({ entries }) => service.reorderSidebar(entries))
    ],
    ['dataProjects.duplicate', route(params.byId, ({ id }) => service.duplicate(id))],

    // ---- Connection ----------------------------------------------------------------------------
    [
      'dataProjects.parseUrl',
      route(params.parseUrl, ({ url, engineHint }) => service.parseUrl(url, engineHint))
    ],
    [
      'dataProjects.testConnection',
      route(params.testConnection, async ({ input }) => {
        assertConnectable(input.engine, input.config)
        return (await service.engine()).testConnection(input)
      })
    ],
    ['dataProjects.connect', withEngine(params.byId, (engine, { id }) => engine.connect(id))],
    ['dataProjects.disconnect', route(params.byId, ({ id }) => service.disconnect(id))],
    ['dataProjects.status', route(params.byId, ({ id }) => service.status(id))],
    [
      'dataProjects.provideSessionSecrets',
      route(params.provideSessionSecrets, ({ id, secrets, remember }) =>
        service.provideSessionSecrets(id, secrets, remember)
      )
    ],

    // ---- Schema --------------------------------------------------------------------------------
    [
      'dataProjects.schema.databases',
      withEngine(params.byId, (engine, { id }) => engine.databases(id))
    ],
    [
      'dataProjects.schema.objects',
      withEngine(params.objects, (engine, { id, database, schema }) =>
        engine.objects(id, database, schema)
      )
    ],
    [
      'dataProjects.schema.describe',
      withEngine(params.ref, (engine, { id, ref }) => engine.describe(id, ref))
    ],
    [
      'dataProjects.schema.ddl',
      withEngine(params.ref, (engine, { id, ref }) => engine.ddl(id, ref))
    ],
    [
      'dataProjects.schema.completion',
      withEngine(params.completion, (engine, { id, database, refresh }) =>
        engine.completionSchema(id, database, refresh)
      )
    ],

    // ---- Queries -------------------------------------------------------------------------------
    [
      'dataProjects.query.execute',
      withEngine(queryRequestSchema, (engine, req, ctx) => engine.execute(req, ctx))
    ],
    [
      'dataProjects.query.cancel',
      route(params.cancelQuery, ({ queryId }) => service.cancelQuery(queryId))
    ],

    // ---- Table data ----------------------------------------------------------------------------
    [
      'dataProjects.table.rows',
      withEngine(tableRowsRequestSchema, (engine, req, ctx) => engine.tableRows(req, ctx))
    ],
    [
      'dataProjects.table.previewEdits',
      withEngine(params.previewEdits, (engine, { id, ref, edits }) =>
        engine.previewEdits(id, ref, edits)
      )
    ],
    [
      'dataProjects.table.applyEdits',
      withEngine(applyEditsRequestSchema, (engine, req, ctx) => engine.applyEdits(req, ctx))
    ],

    // ---- Processes -----------------------------------------------------------------------------
    [
      'dataProjects.processes.list',
      withEngine(params.byId, (engine, { id }) => engine.processes(id))
    ],
    [
      'dataProjects.processes.kill',
      withEngine(params.kill, async (engine, { id, processId, scope }) => {
        await engine.kill(id, processId, scope)
        return { success: true }
      })
    ],

    // ---- Export / files ------------------------------------------------------------------------
    [
      'dataProjects.export.start',
      withEngine(exportRequestSchema, (engine, req, ctx) => engine.exportStart(req, ctx))
    ],
    [
      'dataProjects.export.cancel',
      route(params.cancelExport, ({ exportId }) => service.cancelExport(exportId))
    ],
    // ---- Import ---------------------------------------------------------------------------------
    [
      'dataProjects.import.preview',
      withEngine(importPreviewRequestSchema, (engine, req) => engine.importPreview(req))
    ],
    [
      'dataProjects.import.start',
      withEngine(importStartRequestSchema, (engine, req, ctx) => engine.importStart(req, ctx))
    ],
    [
      'dataProjects.import.cancel',
      // An import can only have started through this service: nothing to cancel before the
      // engine loaded.
      route(params.cancelImport, async ({ importId }) => {
        const engine = service.loadedEngine()
        return engine ? engine.importCancel(importId) : { cancelled: false }
      })
    ],
    [
      'dataProjects.files.saveText',
      route(params.saveText, ({ defaultName, content, extensions }) =>
        service.saveTextFile(defaultName, content, extensions)
      )
    ],
    [
      'dataProjects.files.pick',
      route(params.pickFile, ({ purpose, allowCreate }) => service.pickFile(purpose, allowCreate))
    ],

    // ---- History / saved queries ---------------------------------------------------------------
    [
      'dataProjects.history.list',
      route(params.history, ({ id, search, limit }) => service.history(id, search, limit))
    ],
    ['dataProjects.history.clear', route(params.byId, ({ id }) => service.clearHistory(id))],
    ['dataProjects.saved.list', route(params.byId, ({ id }) => service.savedQueries(id))],
    [
      'dataProjects.saved.save',
      route(params.saveQuery, ({ id, query }) => service.saveQuery(id, query))
    ],
    [
      'dataProjects.saved.delete',
      route(params.deleteSavedQuery, ({ id, savedId }) => service.deleteSavedQuery(id, savedId))
    ],

    // ---- MongoDB -------------------------------------------------------------------------------
    [
      'dataProjects.mongo.find',
      withEngine(mongoFindRequestSchema, (engine, req, ctx) => engine.mongo.find(req, ctx))
    ],
    [
      'dataProjects.mongo.aggregate',
      withEngine(mongoAggregateRequestSchema, (engine, req, ctx) =>
        engine.mongo.aggregate(req, ctx)
      )
    ],
    [
      'dataProjects.mongo.write',
      withEngine(mongoWriteRequestSchema, (engine, req, ctx) => engine.mongo.write(req, ctx))
    ],
    [
      'dataProjects.mongo.indexes',
      withEngine(params.mongoIndexes, (engine, { id, database, collection }) =>
        engine.mongo.indexes(id, database, collection)
      )
    ],
    [
      'dataProjects.mongo.createIndex',
      withEngine(mongoCreateIndexRequestSchema, (engine, req) => engine.mongo.createIndex(req))
    ],
    [
      'dataProjects.mongo.dropIndex',
      withEngine(mongoDropIndexRequestSchema, (engine, req) => engine.mongo.dropIndex(req))
    ],
    [
      'dataProjects.mongo.schema',
      withEngine(mongoSchemaRequestSchema, (engine, req) => engine.mongo.schema(req))
    ],
    [
      'dataProjects.mongo.explain',
      withEngine(mongoExplainRequestSchema, (engine, req) => engine.mongo.explain(req))
    ],
    [
      'dataProjects.mongo.collection',
      withEngine(mongoCollectionRequestSchema, (engine, req) => engine.mongo.collection(req))
    ]
  ])
}
