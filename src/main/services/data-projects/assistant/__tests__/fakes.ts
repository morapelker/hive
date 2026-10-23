// Test doubles for the database assistant: an in-memory engine (the introspection slice of
// DataEngineService) shaped like the live `shop` databases, and a data project record.

import { vi } from 'vitest'
import type {
  DataCompletionSchema,
  DataConnectionStatus,
  DataEngine,
  DataObjectsListing,
  DataStatementOutput,
  DataTableDetails,
  MongoIndexInfo,
  MongoSchemaResponse
} from '../../../../../shared/data-projects/types'
import type { DataProjectRecord } from '../../contracts'
import type { AssistantToolContext } from '../tools'
import type { AssistantEngineService } from '../types'

export function sampleRecord(overrides: Partial<DataProjectRecord> = {}): DataProjectRecord {
  return {
    id: 'dp-1',
    name: 'Shop PG',
    engine: 'postgres',
    config: { host: '127.0.0.1', port: 15432, database: 'shop', user: 'postgres' },
    icon: null,
    iconColor: null,
    environment: 'development',
    color: null,
    safeMode: 'off',
    defaultLimit: 1000,
    allowAiDataAccess: false,
    pinned: false,
    secretCiphertext: null,
    secretState: 'stored',
    sortOrder: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastAccessedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  }
}

export const ORDERS_DETAILS: DataTableDetails = {
  ref: { database: 'shop', schema: 'public', name: 'orders' },
  kind: 'table',
  columns: [
    {
      name: 'id',
      type: 'integer',
      nullable: false,
      isPrimaryKey: true,
      ordinal: 1,
      autoIncrement: true
    },
    { name: 'user_id', type: 'integer', nullable: false, isPrimaryKey: false, ordinal: 2 },
    {
      name: 'status',
      type: 'text',
      nullable: false,
      isPrimaryKey: false,
      ordinal: 3,
      defaultValue: "'new'::text"
    },
    { name: 'total', type: 'numeric(10,2)', nullable: false, isPrimaryKey: false, ordinal: 4 },
    {
      name: 'created_at',
      type: 'timestamp with time zone',
      nullable: false,
      isPrimaryKey: false,
      ordinal: 5
    }
  ],
  indexes: [
    { name: 'orders_pkey', columns: ['id'], unique: true, primary: true },
    { name: 'orders_user_id_idx', columns: ['user_id'], unique: false, primary: false }
  ],
  foreignKeys: [
    {
      name: 'orders_user_id_fkey',
      columns: ['user_id'],
      refSchema: 'public',
      refTable: 'users',
      refColumns: ['id'],
      onDelete: 'CASCADE'
    }
  ],
  triggers: [],
  primaryKey: ['id'],
  rowEstimate: 1234
}

export const SHOP_LISTING: DataObjectsListing = {
  schemas: ['public', 'analytics'],
  objects: [
    { name: 'users', schema: 'public', kind: 'table', rowEstimate: 50 },
    { name: 'products', schema: 'public', kind: 'table', rowEstimate: 20 },
    {
      name: 'orders',
      schema: 'public',
      kind: 'table',
      rowEstimate: 1234,
      comment: 'customer orders'
    },
    { name: 'order_items', schema: 'public', kind: 'table', rowEstimate: 4000 },
    { name: 'touch_updated_at', schema: 'public', kind: 'function' }
  ]
}

export const SHOP_COMPLETION: DataCompletionSchema = {
  database: 'shop',
  defaultSchema: 'public',
  databases: ['shop', 'postgres'],
  schemas: ['public', 'analytics'],
  tables: [
    {
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [
        { name: 'id', type: 'int4' },
        { name: 'email', type: 'text' },
        { name: 'created_at', type: 'timestamptz' }
      ]
    },
    {
      schema: 'public',
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', type: 'int4' },
        { name: 'user_id', type: 'int4' },
        { name: 'status', type: 'text' },
        { name: 'created_at', type: 'timestamptz' }
      ]
    },
    {
      schema: 'analytics',
      name: 'daily_revenue',
      kind: 'view',
      columns: [
        { name: 'day', type: 'date' },
        { name: 'revenue', type: 'numeric' }
      ]
    }
  ]
}

export const ORDERS_SAMPLE: DataStatementOutput = {
  kind: 'rows',
  columns: [{ name: 'id' }, { name: 'status' }, { name: 'password_hash' }],
  rows: [
    [1, 'paid', '$2b$10$abc'],
    [2, 'shipped', '$2b$10$def']
  ],
  truncated: false,
  limit: 3,
  autoLimited: false
}

export const MONGO_ORDERS_SCHEMA: MongoSchemaResponse = {
  sampleSize: 50,
  count: 300,
  fields: [
    { path: '_id', probability: 1, types: [{ type: 'ObjectId', probability: 1 }] },
    {
      path: 'status',
      probability: 1,
      types: [{ type: 'String', probability: 1 }],
      sampleValues: ['"paid"', '"shipped"']
    },
    {
      path: 'createdAt',
      probability: 0.8,
      types: [
        { type: 'Date', probability: 0.75 },
        { type: 'Null', probability: 0.25 }
      ]
    }
  ]
}

export const MONGO_INDEXES: MongoIndexInfo[] = [
  { name: '_id_', keys: { _id: 1 }, unique: true, sparse: false, hidden: false },
  {
    name: 'createdAt_-1',
    keys: { createdAt: -1 },
    unique: false,
    sparse: false,
    hidden: false,
    ttlSeconds: 3600
  }
]

const CONNECTED: DataConnectionStatus = {
  dataProjectId: 'dp-1',
  state: 'connected',
  serverVersion: '17.2',
  currentDatabase: 'shop'
}

export function fakeEngine(
  overrides: Partial<Omit<AssistantEngineService, 'mongo'>> & {
    mongo?: Partial<AssistantEngineService['mongo']>
  } = {}
): AssistantEngineService {
  const { mongo, ...rest } = overrides
  return {
    status: vi.fn(() => CONNECTED),
    connect: vi.fn(async () => CONNECTED),
    databases: vi.fn(async () => [
      { name: 'shop' },
      { name: 'postgres' },
      { name: 'template1', isSystem: true }
    ]),
    objects: vi.fn(async () => SHOP_LISTING),
    describe: vi.fn(async () => ORDERS_DETAILS),
    ddl: vi.fn(async () => 'CREATE TABLE public.orders (\n  id integer NOT NULL\n);'),
    completionSchema: vi.fn(async () => SHOP_COMPLETION),
    sampleRows: vi.fn(async () => ORDERS_SAMPLE),
    ...rest,
    mongo: {
      schema: vi.fn(async () => MONGO_ORDERS_SCHEMA),
      indexes: vi.fn(async () => MONGO_INDEXES),
      ...mongo
    }
  }
}

export function toolContext(
  overrides: Partial<AssistantToolContext> & { engine?: DataEngine } = {}
): AssistantToolContext {
  return {
    dataProjectId: 'dp-1',
    engine: 'postgres',
    allowDataAccess: false,
    database: 'shop',
    schema: 'public',
    service: fakeEngine(),
    signal: new AbortController().signal,
    now: () => new Date('2026-10-23T11:05:00.000Z'),
    timeZone: 'America/New_York',
    ...overrides
  }
}
