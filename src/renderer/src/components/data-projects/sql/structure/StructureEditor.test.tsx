// The structure editor against a mocked API and the real workspace / confirm stores: in-place
// edits staged with their row state, Review SQL, Apply through the safety confirmation (token
// re-call, source 'schema-action'), the schema refresh after it, a run stopped by a failing
// statement (banner + the rest stays staged under the new name), new columns with the type picker,
// the index dialog, drop / undo, problems that block Apply, read-only states (safe mode, views,
// SQLite limits), MySQL MODIFY keeping the column definition, constraints, the staged count in
// the workspace store and Discard from the workspace's leave question.
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataColumnInfo,
  DataExecutionPlan,
  DataProject,
  DataQueryRequest,
  DataQueryResponse,
  DataTableDetails,
  SqlDialect
} from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  ddl: vi.fn(async (): Promise<string> => ''),
  execute: vi.fn(),
  status: vi.fn(),
  serverVersion: 'PostgreSQL 17.11' as string | undefined,
  inTransaction: false,
  insert: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    ddl: mocks.ddl,
    execute: mocks.execute,
    status: mocks.status,
    cancel: vi.fn(async () => ({ cancelled: true })),
    completionSchema: vi.fn(async () => ({ databases: [], tables: [] }))
  }
}))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = () => ({
    statuses: {
      'dp-1': {
        state: 'connected',
        serverVersion: mocks.serverVersion,
        inTransaction: mocks.inTransaction
      }
    },
    openCredentialsPrompt: vi.fn()
  })
  return {
    useDataProjectStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state }
    )
  }
})
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))
vi.mock('@/components/ui/dropdown-menu', () => {
  type Props = { children?: ReactNode; 'data-testid'?: string }
  const Pass = ({ children }: Props): ReactNode => children
  const Item = ({
    children,
    onSelect,
    'data-testid': testId
  }: Props & { onSelect?: () => void }): ReactNode => (
    <button type="button" data-testid={testId} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null
  }
})

const { StructureEditor } = await import('./StructureEditor')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { DataConfirmHost } = await import('../../shared/DataConfirmHost')
const { useDataConfirmStore } = await import('../../shared/confirm')
const { structureStagedKey } = await import('./staged-key')
const { useDataEditorBridge } = await import('@/components/data-projects/editor-bridge')

const baseProject: DataProject = {
  id: 'dp-1',
  name: 'Shop',
  engine: 'postgres',
  config: { database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T00:00:00.000Z'
}
const tab = {
  id: 'table-1',
  kind: 'table' as const,
  title: 'users',
  view: 'structure' as const,
  ref: { database: 'shop', schema: 'public', name: 'users', kind: 'table' as const }
}

const col = (name: string, type: string, extra: Partial<DataColumnInfo> = {}): DataColumnInfo => ({
  name,
  type,
  nullable: true,
  defaultValue: null,
  isPrimaryKey: false,
  ordinal: 0,
  ...extra
})

function pgDetails(columns?: DataColumnInfo[]): DataTableDetails {
  const cols = columns ?? [
    col('id', 'integer', { isPrimaryKey: true, nullable: false }),
    col('name', 'text', { nullable: false }),
    col('note', 'text', { comment: 'old' })
  ]
  return {
    ref: { database: 'shop', schema: 'public', name: 'users', kind: 'table' },
    kind: 'table',
    columns: cols.map((c, i) => ({ ...c, ordinal: i + 1 })),
    indexes: [
      { name: 'users_pkey', columns: ['id'], unique: true, primary: true, type: 'btree' },
      { name: 'idx_users_note', columns: ['note'], unique: false, primary: false, type: 'btree' }
    ],
    foreignKeys: [],
    triggers: [],
    primaryKey: ['id']
  }
}

const PG_DDL = `CREATE TABLE public.users (
  id integer NOT NULL,
  name text NOT NULL,
  note text,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_name_check CHECK (length(name) > 0)
);`

const okResponse = (texts: string[], errorAt = -1): DataQueryResponse => ({
  status: 'ok',
  durationMs: 3,
  inTransaction: false,
  statements: texts.slice(0, errorAt >= 0 ? errorAt + 1 : texts.length).map((text, index) => ({
    index,
    text,
    start: 0,
    end: text.length,
    classification: 'ddl' as const,
    durationMs: 1,
    output: index === errorAt ? null : { kind: 'command' as const, rowCount: 0 },
    ...(index === errorAt ? { error: { message: `type "bad" does not exist`, code: '42704' } } : {})
  }))
})

const plan = (text: string): DataExecutionPlan => ({
  dataProjectId: 'dp-1',
  projectName: 'Shop',
  engine: 'postgres',
  environment: 'local',
  safeMode: 'safe',
  database: 'shop',
  statements: [
    {
      index: 0,
      text,
      start: 0,
      end: text.length,
      classification: 'ddl',
      dangerous: [],
      reasons: ['ddl'],
      needsConfirmation: true
    }
  ]
})

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  mocks.ddl.mockReset()
  mocks.ddl.mockImplementation(async () => PG_DDL)
  mocks.execute.mockReset()
  mocks.status.mockReset()
  mocks.status.mockImplementation(async () => ({
    dataProjectId: 'dp-1',
    state: 'connected',
    inTransaction: mocks.inTransaction
  }))
  mocks.insert.mockReset()
  useDataEditorBridge.setState({ insert: mocks.insert })
  mocks.serverVersion = 'PostgreSQL 17.11'
  mocks.inTransaction = false
  for (const fn of Object.values(mocks.toast)) fn.mockReset()
})
afterEach(() => {
  useDataConfirmStore.getState().cancelAll()
  cleanup()
})

interface RenderOptions {
  project?: DataProject
  dialect?: SqlDialect
  details?: DataTableDetails
  onApplied?: () => void
}

function renderEditor(options: RenderOptions = {}) {
  const props = {
    project: options.project ?? baseProject,
    dialect: options.dialect ?? ('postgres' as SqlDialect),
    tab,
    details: options.details ?? pgDetails(),
    detailsLoading: false,
    detailsError: null,
    onReload: vi.fn(),
    onApplied: options.onApplied ?? vi.fn()
  }
  const view = render(
    <>
      <StructureEditor {...props} />
      <DataConfirmHost />
    </>
  )
  return {
    props,
    rerender: (patch: Partial<typeof props>) =>
      view.rerender(
        <>
          <StructureEditor {...props} {...patch} />
          <DataConfirmHost />
        </>
      )
  }
}

const row = (name: string): HTMLElement =>
  screen.getByTestId(`data-project-structure-column-${name}`)
const field = (scope: HTMLElement, id: string): HTMLInputElement =>
  within(scope).getByTestId(`data-project-structure-col-${id}`) as HTMLInputElement
const type = (input: HTMLElement, value: string): void => {
  fireEvent.change(input, { target: { value } })
}
const reviewSql = (): string =>
  screen.getByTestId('data-project-structure-review-sql').textContent ?? ''

describe('StructureEditor', () => {
  it('stages edits in place, reviews the DDL and applies it through the confirmation', async () => {
    const onApplied = vi.fn()
    renderEditor({ onApplied })
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'name'), 'memo')
    type(field(row('note'), 'type'), 'varchar(20)')
    expect(row('note')).toHaveAttribute('data-state', 'modified')
    expect(screen.getByTestId('data-project-structure-pending-count')).toHaveTextContent(
      '1 pending structure change'
    )
    expect(useDataWorkspaceStore.getState().stagedEdits[structureStagedKey('table-1')]).toBe(1)

    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    const statements = [
      'ALTER TABLE "public"."users" RENAME COLUMN "note" TO "memo"',
      'ALTER TABLE "public"."users" ALTER COLUMN "memo" TYPE varchar(20)'
    ]
    const text = statements.map((s) => `${s};`).join('\n')
    expect(reviewSql()).toBe(text)

    mocks.execute
      .mockResolvedValueOnce({
        status: 'confirmation_required',
        plan: plan(text),
        confirmToken: 'tok'
      })
      .mockResolvedValueOnce(okResponse(statements))
    const before = useDataWorkspaceStore.getState().schemaVersion['dp-1'] ?? 0
    fireEvent.click(screen.getByTestId('data-project-structure-review-apply'))
    await screen.findByTestId('data-project-confirm-dialog')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-confirm-run'))
    })
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
    const [first, second] = mocks.execute.mock.calls.map((c) => c[0] as DataQueryRequest)
    expect(first).toMatchObject({
      dataProjectId: 'dp-1',
      text,
      database: 'shop',
      source: 'schema-action',
      stopOnError: true,
      limit: null
    })
    expect(first.confirmToken).toBeUndefined()
    expect(second).toMatchObject({ text, confirmToken: 'tok', source: 'schema-action' })
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled())
    expect(onApplied).toHaveBeenCalled()
    expect(useDataWorkspaceStore.getState().schemaVersion['dp-1']).toBe(before + 1)
    expect(screen.queryByTestId('data-project-structure-pending-bar')).toBeNull()
    expect(
      useDataWorkspaceStore.getState().stagedEdits[structureStagedKey('table-1')]
    ).toBeUndefined()
    // The schema change reloads the DDL (constraints, MySQL definitions).
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalledTimes(2))
  })

  it('a failing statement stops the run: banner, applied part dropped, the rest stays staged', async () => {
    const view = renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'name'), 'memo')
    type(field(row('note'), 'type'), 'bad')
    const statements = [
      'ALTER TABLE "public"."users" RENAME COLUMN "note" TO "memo"',
      'ALTER TABLE "public"."users" ALTER COLUMN "memo" TYPE bad'
    ]
    mocks.execute.mockResolvedValueOnce(okResponse(statements, 1))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-structure-apply'))
    })
    const banner = await screen.findByTestId('data-project-structure-apply-error')
    expect(banner).toHaveTextContent(
      'Statement 2 of 2 failed; the 1 statement before it was applied'
    )
    expect(banner).toHaveTextContent('type "bad" does not exist')
    // Until the table is described again, nothing more can be applied.
    expect(screen.getByTestId('data-project-structure-apply')).toBeDisabled()
    view.rerender({
      details: pgDetails([
        col('id', 'integer', { isPrimaryKey: true, nullable: false }),
        col('name', 'text', { nullable: false }),
        col('memo', 'text', { comment: 'old' })
      ])
    })
    await waitFor(() => expect(field(row('memo'), 'type').value).toBe('bad'))
    expect(row('memo')).toHaveAttribute('data-state', 'modified')
    expect(screen.getByTestId('data-project-structure-pending-count')).toHaveTextContent(
      '1 pending'
    )
    expect(screen.getByTestId('data-project-structure-apply')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe('ALTER TABLE "public"."users" ALTER COLUMN "memo" TYPE bad;')
  })

  it('adds a column with the type picker and a unique index from the dialog', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('data-project-structure-add-column'))
    const added = screen.getByTestId('data-project-structure-new-column-0')
    expect(field(added, 'name')).toHaveFocus()
    type(field(added, 'name'), 'age')
    fireEvent.click(within(added).getByTestId('data-project-structure-type-option-integer'))
    fireEvent.click(field(added, 'nullable'))
    type(field(added, 'default'), '0')
    type(field(added, 'comment'), 'years')

    fireEvent.click(screen.getByTestId('data-project-structure-add-index'))
    const dialog = await screen.findByTestId('data-project-structure-index-dialog')
    fireEvent.click(within(dialog).getByTestId('data-project-structure-index-column-age'))
    fireEvent.click(within(dialog).getByTestId('data-project-structure-index-unique'))
    expect(
      (within(dialog).getByTestId('data-project-structure-index-name') as HTMLInputElement).value
    ).toBe('users_age_key')
    expect(within(dialog).getByTestId('data-project-structure-index-preview')).toHaveTextContent(
      'CREATE UNIQUE INDEX "users_age_key" ON "public"."users" ("age");'
    )
    fireEvent.click(within(dialog).getByTestId('data-project-structure-index-save'))
    expect(screen.getByTestId('data-project-structure-new-index-users_age_key')).toBeTruthy()

    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe(
      [
        'ALTER TABLE "public"."users" ADD COLUMN "age" integer DEFAULT 0 NOT NULL;',
        'COMMENT ON COLUMN "public"."users"."age" IS \'years\';',
        'CREATE UNIQUE INDEX "users_age_key" ON "public"."users" ("age");'
      ].join('\n')
    )
  })

  it('drop and undo; the primary key index cannot be dropped', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    fireEvent.click(within(row('note')).getByTestId('data-project-structure-col-drop'))
    expect(row('note')).toHaveAttribute('data-state', 'dropped')
    expect(field(row('note'), 'name')).toBeDisabled()
    const idx = screen.getByTestId('data-project-structure-index-idx_users_note')
    fireEvent.click(within(idx).getByTestId('data-project-structure-index-drop'))
    expect(idx).toHaveAttribute('data-state', 'dropped')
    expect(screen.getByTestId('data-project-structure-pending-count')).toHaveTextContent(
      '2 pending'
    )
    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe(
      'DROP INDEX "public"."idx_users_note";\nALTER TABLE "public"."users" DROP COLUMN "note";'
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(within(row('note')).getByTestId('data-project-structure-col-revert'))
    fireEvent.click(within(idx).getByTestId('data-project-structure-index-revert'))
    expect(screen.queryByTestId('data-project-structure-pending-bar')).toBeNull()
    const pkey = screen.getByTestId('data-project-structure-index-users_pkey')
    const drop = within(pkey).getByTestId('data-project-structure-index-drop')
    expect(drop).toBeDisabled()
    expect(drop.getAttribute('title')).toMatch(/Primary key/)
    // The primary key column cannot be made nullable.
    expect(field(row('id'), 'nullable')).toBeDisabled()
  })

  it('problems block Apply; an unquoted text default only warns', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'name'), 'name')
    expect(field(row('note'), 'name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('data-project-structure-problems')).toHaveTextContent('1 problem')
    expect(screen.getByTestId('data-project-structure-apply')).toBeDisabled()
    type(field(row('note'), 'name'), 'note')
    type(field(row('note'), 'default'), 'hello')
    expect(screen.queryByTestId('data-project-structure-problems')).toBeNull()
    expect(screen.getByTestId('data-project-structure-apply')).not.toBeDisabled()
    expect(field(row('note'), 'default').getAttribute('title')).toMatch(/quote it \('hello'\)/)
    fireEvent.click(within(row('note')).getByTestId('data-project-structure-col-default-quote'))
    expect(field(row('note'), 'default').value).toBe("'hello'")
  })

  it('⌘S applies the staged changes', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'comment'), 'new comment')
    const statement = 'COMMENT ON COLUMN "public"."users"."note" IS \'new comment\''
    mocks.execute.mockResolvedValueOnce(okResponse([statement]))
    await act(async () => {
      fireEvent.keyDown(field(row('note'), 'comment'), { key: 's', metaKey: true })
    })
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1))
    expect((mocks.execute.mock.calls[0][0] as DataQueryRequest).text).toBe(`${statement};`)
  })

  it('read-only mode and views show the structure read-only with the reason', async () => {
    renderEditor({ project: { ...baseProject, safeMode: 'read-only' } })
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    expect(screen.getByTestId('data-project-structure-readonly')).toHaveTextContent(
      'Read-only mode'
    )
    expect(screen.queryByTestId('data-project-structure-add-column')).toBeNull()
    expect(field(row('name'), 'name')).toBeDisabled()
    expect(within(row('name')).queryByTestId('data-project-structure-col-drop')).toBeNull()
    cleanup()
    renderEditor({ details: { ...pgDetails(), kind: 'view' } })
    expect(screen.getByTestId('data-project-structure-readonly')).toHaveTextContent(
      'view’s columns come from its query'
    )
  })

  it('SQLite: only rename / drop / add, the rest is locked with the reason', async () => {
    mocks.serverVersion = 'SQLite 3.51.0'
    mocks.ddl.mockImplementation(
      async () => 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT);'
    )
    renderEditor({
      dialect: 'sqlite',
      project: { ...baseProject, engine: 'sqlite' },
      details: {
        ...pgDetails(),
        ref: { database: 'main', name: 'users', kind: 'table' },
        indexes: []
      }
    })
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    const typeInput = field(row('note'), 'type')
    expect(typeInput).toBeDisabled()
    expect(typeInput.getAttribute('title')).toMatch(/SQLite cannot change/)
    expect(field(row('note'), 'default')).toBeDisabled()
    expect(within(row('note')).queryByTestId('data-project-structure-col-comment')).toBeNull()
    type(field(row('note'), 'name'), 'memo')
    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe('ALTER TABLE "main"."users" RENAME COLUMN "note" TO "memo";')
  })

  it('MySQL: MODIFY keeps the rest of the column definition from SHOW CREATE TABLE', async () => {
    mocks.serverVersion = '8.4.13'
    mocks.ddl.mockImplementation(
      async () => `CREATE TABLE \`users\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`ts\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'when',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;`
    )
    renderEditor({
      dialect: 'mysql',
      project: { ...baseProject, engine: 'mysql' },
      details: {
        ...pgDetails([
          col('id', 'int', { isPrimaryKey: true, nullable: false, autoIncrement: true }),
          col('ts', 'timestamp', { defaultValue: 'CURRENT_TIMESTAMP', comment: 'when' })
        ]),
        ref: { database: 'shop', name: 'users', kind: 'table' },
        indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true, primary: true }]
      }
    })
    await waitFor(() => expect(field(row('ts'), 'nullable')).not.toBeDisabled())
    fireEvent.click(field(row('ts'), 'nullable'))
    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe(
      "ALTER TABLE `shop`.`users`\n  MODIFY COLUMN `ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'when';"
    )
  })

  it('ClickHouse: Nullable follows the type, key columns are locked, skipping indexes', async () => {
    mocks.serverVersion = 'ClickHouse 24.8.14.39'
    mocks.ddl.mockImplementation(
      async () =>
        'CREATE TABLE shop.users\n(\n    `id` UInt64,\n    `n` Int32,\n    `tags` Array(String)\n)\nENGINE = MergeTree\nORDER BY id'
    )
    renderEditor({
      dialect: 'clickhouse',
      project: { ...baseProject, engine: 'clickhouse' },
      details: {
        ...pgDetails([
          col('id', 'UInt64', { isPrimaryKey: true, nullable: false, extra: 'sorting key' }),
          col('n', 'Int32', { nullable: false }),
          col('tags', 'Array(String)', { nullable: false })
        ]),
        ref: { database: 'shop', name: 'users', kind: 'table' },
        engine: 'MergeTree',
        indexes: []
      }
    })
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    expect(field(row('id'), 'name')).toBeDisabled()
    expect(field(row('id'), 'name').getAttribute('title')).toMatch(/sorting key/)
    expect(field(row('tags'), 'nullable')).toBeDisabled()
    fireEvent.click(field(row('n'), 'nullable'))
    expect(field(row('n'), 'nullable')).toHaveAttribute('aria-checked', 'true')
    expect(field(row('n'), 'type').value).toBe('Nullable(Int32)')
    fireEvent.click(screen.getByTestId('data-project-structure-add-index'))
    const dialog = await screen.findByTestId('data-project-structure-index-dialog')
    expect(within(dialog).queryByTestId('data-project-structure-index-unique')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('data-project-structure-index-column-n'))
    type(within(dialog).getByTestId('data-project-structure-index-skip-type'), 'set(100)')
    fireEvent.click(within(dialog).getByTestId('data-project-structure-index-save'))
    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe(
      [
        'ALTER TABLE `shop`.`users` MODIFY COLUMN `n` Nullable(Int32);',
        'ALTER TABLE `shop`.`users` ADD INDEX `idx_n` `n` TYPE set(100) GRANULARITY 1;'
      ].join('\n')
    )
  })

  it('lists CHECK constraints from the DDL read-only', async () => {
    renderEditor()
    const section = await screen.findByTestId('data-project-structure-constraints')
    expect(section).toHaveTextContent('CHECK')
    expect(section).toHaveTextContent('users_name_check')
    expect(section).toHaveTextContent('length(name) > 0')
  })

  it('Discard answered in the workspace leave question drops the staged changes', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'comment'), 'x')
    expect(screen.getByTestId('data-project-structure-pending-bar')).toBeTruthy()
    act(() => useDataWorkspaceStore.getState().discardStagedEdits('dp-1'))
    await waitFor(() =>
      expect(screen.queryByTestId('data-project-structure-pending-bar')).toBeNull()
    )
    expect(
      useDataWorkspaceStore.getState().stagedEdits[structureStagedKey('table-1')]
    ).toBeUndefined()
  })

  // ---- Engine rules -------------------------------------------------------------------------

  const mysqlDetails = (): DataTableDetails => ({
    ...pgDetails([
      col('id', 'int', { isPrimaryKey: true, nullable: false }),
      col('p', 'varchar(20)'),
      col('q', 'int')
    ]),
    ref: { database: 'shop', name: 'users', kind: 'table' },
    indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true, primary: true }]
  })
  const MYSQL_DDL = `CREATE TABLE \`users\` (
  \`id\` int NOT NULL,
  \`p\` varchar(20) DEFAULT 'C:\\\\tmp',
  \`q\` int DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;`
  const renderMysql = () => {
    mocks.serverVersion = '8.4.13'
    mocks.ddl.mockImplementation(async () => MYSQL_DDL)
    return renderEditor({
      dialect: 'mysql',
      project: { ...baseProject, engine: 'mysql' },
      details: mysqlDetails()
    })
  }

  it('MySQL: Apply waits while the connection has an open transaction (DDL would commit it)', async () => {
    mocks.inTransaction = true
    renderMysql()
    await waitFor(() => expect(field(row('q'), 'comment')).not.toBeDisabled())
    type(field(row('q'), 'comment'), 'note')
    const applyButton = screen.getByTestId('data-project-structure-apply')
    expect(applyButton).toBeDisabled()
    expect(applyButton.getAttribute('title')).toMatch(
      /open transaction .* MySQL commits it before running any DDL/
    )
  })

  it('MySQL: a NO_BACKSLASH_ESCAPES session found at Apply rebuilds the statements', async () => {
    renderMysql()
    await waitFor(() => expect(field(row('p'), 'type')).not.toBeDisabled())
    expect(field(row('p'), 'default').value).toBe("'C:\\\\tmp'")
    type(field(row('p'), 'type'), 'varchar(30)')
    mocks.execute.mockResolvedValueOnce({
      status: 'ok',
      durationMs: 1,
      inTransaction: false,
      statements: [
        {
          index: 0,
          text: 'SELECT @@SESSION.sql_mode',
          start: 0,
          end: 25,
          classification: 'read',
          durationMs: 1,
          output: {
            kind: 'rows',
            columns: [{ name: 'm', type: 'varchar' }],
            rows: [['STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES']],
            truncated: false,
            limit: null,
            autoLimited: false
          }
        }
      ]
    } satisfies DataQueryResponse)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-structure-apply'))
    })
    const banner = await screen.findByTestId('data-project-structure-apply-error')
    expect(banner).toHaveTextContent('Nothing was applied.')
    expect(banner).toHaveTextContent('runs with NO_BACKSLASH_ESCAPES')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    // The kept default is restated for the session: one backslash, as it reads there.
    expect(field(row('p'), 'default').value).toBe("'C:\\tmp'")
    fireEvent.click(screen.getByTestId('data-project-structure-review'))
    expect(reviewSql()).toBe(
      "ALTER TABLE `shop`.`users`\n  MODIFY COLUMN `p` varchar(30) DEFAULT 'C:\\tmp';"
    )
  })

  it('PostgreSQL: a failure inside an open transaction keeps every change staged', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'name'), 'memo')
    type(field(row('note'), 'type'), 'bad')
    const statements = [
      'ALTER TABLE "public"."users" RENAME COLUMN "note" TO "memo"',
      'ALTER TABLE "public"."users" ALTER COLUMN "memo" TYPE bad'
    ]
    mocks.execute.mockResolvedValueOnce({ ...okResponse(statements, 1), inTransaction: true })
    const before = useDataWorkspaceStore.getState().schemaVersion['dp-1'] ?? 0
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-structure-apply'))
    })
    const banner = await screen.findByTestId('data-project-structure-apply-error')
    expect(banner).toHaveTextContent(
      'Statement 2 of 2 failed inside the open transaction, which is now aborted: nothing of this run will be kept.'
    )
    expect(banner).toHaveTextContent('ROLLBACK in a query tab')
    expect(mocks.toast.warning).not.toHaveBeenCalled()
    expect(useDataWorkspaceStore.getState().schemaVersion['dp-1'] ?? 0).toBe(before)
    // Both edits are still staged against the (unchanged) column.
    expect(field(row('note'), 'name').value).toBe('memo')
    expect(field(row('note'), 'type').value).toBe('bad')
    expect(screen.getByTestId('data-project-structure-apply')).not.toBeDisabled()
  })

  it('PostgreSQL: the USING placeholder names the column as it is when USING runs', async () => {
    renderEditor()
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    type(field(row('note'), 'name'), 'memo')
    type(field(row('note'), 'type'), 'integer')
    expect(field(row('note'), 'using').getAttribute('placeholder')).toBe('USING "memo"::integer')
    type(field(row('note'), 'using'), '"note"::integer')
    expect(field(row('note'), 'using')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('data-project-structure-apply')).toBeDisabled()
  })

  it('ClickHouse: a retype is reviewed first; a failed conversion is reported as in effect, with the way back', async () => {
    mocks.serverVersion = 'ClickHouse 24.8.14.39'
    const chDdl = (type: string) =>
      `CREATE TABLE shop.users\n(\n    \`id\` UInt64,\n    \`n\` ${type}\n)\nENGINE = MergeTree\nORDER BY id`
    mocks.ddl.mockImplementation(async () => chDdl('Nullable(String)'))
    const onApplied = vi.fn()
    renderEditor({
      dialect: 'clickhouse',
      project: { ...baseProject, engine: 'clickhouse' },
      onApplied,
      details: {
        ...pgDetails([
          col('id', 'UInt64', { isPrimaryKey: true, nullable: false, extra: 'sorting key' }),
          col('n', 'Nullable(String)')
        ]),
        ref: { database: 'shop', name: 'users', kind: 'table' },
        engine: 'MergeTree',
        indexes: []
      }
    })
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    fireEvent.click(field(row('n'), 'nullable'))
    expect(field(row('n'), 'type').value).toBe('String')
    expect(screen.getByTestId('data-project-structure-warnings')).toHaveTextContent('1 warning')
    // Apply opens the review, which shows the warning; nothing is sent yet.
    fireEvent.click(screen.getByTestId('data-project-structure-apply'))
    expect(await screen.findByTestId('data-project-structure-review-dialog')).toBeTruthy()
    expect(screen.getByTestId('data-project-structure-issues')).toHaveTextContent(
      'Removing Nullable from "n"'
    )
    expect(mocks.execute).not.toHaveBeenCalled()

    const sql = 'ALTER TABLE `shop`.`users` MODIFY COLUMN `n` String'
    mocks.execute.mockResolvedValueOnce({
      status: 'ok',
      durationMs: 1,
      statements: [
        {
          index: 0,
          text: sql,
          start: 0,
          end: sql.length,
          classification: 'ddl',
          durationMs: 1,
          output: null,
          error: { message: 'Cannot convert NULL value to non-Nullable type' }
        }
      ]
    } satisfies DataQueryResponse)
    // ClickHouse kept the new type although the ALTER failed.
    mocks.ddl.mockImplementation(async () => chDdl('String'))
    const before = useDataWorkspaceStore.getState().schemaVersion['dp-1'] ?? 0
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-structure-review-apply'))
    })
    const banner = await screen.findByTestId('data-project-structure-apply-error')
    expect(banner).toHaveTextContent(
      'The statement failed after its type change took effect: "n" is now String'
    )
    expect(banner).not.toHaveTextContent('nothing was applied')
    expect(screen.getByTestId('data-project-structure-apply-error-revert-sql')).toHaveTextContent(
      'ALTER TABLE `shop`.`users` MODIFY COLUMN `n` Nullable(String);'
    )
    // The table is read again even though no statement succeeded.
    expect(useDataWorkspaceStore.getState().schemaVersion['dp-1']).toBe(before + 1)
    expect(onApplied).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('data-project-structure-apply-error-revert-open'))
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'ALTER TABLE `shop`.`users` MODIFY COLUMN `n` Nullable(String);',
        mode: 'new-tab'
      })
    )
    mocks.execute.mockResolvedValueOnce(
      okResponse(['ALTER TABLE `shop`.`users` MODIFY COLUMN `n` Nullable(String)'])
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-structure-apply-error-revert'))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('data-project-structure-apply-error')).toBeNull()
    )
    expect((mocks.execute.mock.calls[1][0] as DataQueryRequest).text).toBe(
      'ALTER TABLE `shop`.`users` MODIFY COLUMN `n` Nullable(String);'
    )
    expect(mocks.toast.success).toHaveBeenCalledWith('The type was changed back')
  })

  it('SQLite: no CURRENT_TIMESTAMP preset for a new column of a table with rows', async () => {
    mocks.serverVersion = 'SQLite 3.51.0'
    mocks.ddl.mockImplementation(async () => 'CREATE TABLE users (id INTEGER PRIMARY KEY);')
    const sqliteDetails = (rowEstimate: number): DataTableDetails => ({
      ...pgDetails([col('id', 'INTEGER', { isPrimaryKey: true, nullable: false })]),
      ref: { database: 'main', name: 'users', kind: 'table' },
      indexes: [],
      rowEstimate
    })
    const view = renderEditor({
      dialect: 'sqlite',
      project: { ...baseProject, engine: 'sqlite' },
      details: sqliteDetails(2)
    })
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('data-project-structure-add-column'))
    const added = screen.getByTestId('data-project-structure-new-column-0')
    expect(
      within(added).getByTestId('data-project-structure-col-default-no-now')
    ).toHaveTextContent('SQLite cannot add a column with a non-constant default')
    expect(
      within(added).queryByTestId('data-project-structure-col-default-now-CURRENT_TIMESTAMP')
    ).toBeNull()
    // Typed anyway: a warning that makes Apply review first.
    type(field(added, 'default'), 'CURRENT_TIMESTAMP')
    expect(field(added, 'default').getAttribute('title')).toMatch(/table that has rows/)
    view.rerender({ details: sqliteDetails(0) })
    await waitFor(() =>
      expect(
        within(screen.getByTestId('data-project-structure-new-column-0')).getByTestId(
          'data-project-structure-col-default-now-CURRENT_TIMESTAMP'
        )
      ).toBeTruthy()
    )
  })
})
