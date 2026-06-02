# Effect Conventions

This directory holds shared infrastructure for every Effect "island" in the main process. Read this before adding a new island or editing an existing one.

## What is an island?

An **island** is a self-contained Effect-using subsystem that lives at `src/main/effect/<name>/`. It exposes a Promise-returning facade to the rest of the codebase and keeps all Effect types (`Effect`, `Layer`, `Context.Tag`, `ManagedRuntime`, etc.) internal to the island.

The reference implementation is `src/main/effect/bash/`.

## Required file layout

Every island MUST contain these files (additional files are fine when they help):

```
src/main/effect/<name>/
|-- errors.ts        # Tagged error classes (Data.TaggedError(...))
|-- service.ts       # Context.Tag definitions for the island's services
|-- layers.ts        # Live Layer implementations
|-- runtime.ts       # Thin runtime accessor that delegates to _shared/runtime.ts
|-- facade.ts        # Public Promise-returning API (the only file outsiders import)
`-- __tests__/
    `-- <name>-service.effect.test.ts
```

## Layering rules

1. **`errors.ts`** - every failure mode is a `Data.TaggedError("...")<{ ... }>` class. The `_tag` becomes the `errorCode` at the IPC envelope boundary, so pick names that read well in user-facing error reports.
2. **`service.ts`** - `Context.Tag` declarations only. Tag IDs must be namespaced (e.g. `'BashIsland/Bash'`, `'BashIsland/EventSink'`) to avoid collisions across islands.
3. **`layers.ts`** - Live `Layer` implementations. Side-effecting dependencies (spawning processes, opening sockets, talking to Electron APIs) live here, not in `service.ts`.
4. **`runtime.ts`** - calls `getOrCreateRuntime('<island-name>', () => ManagedRuntime.make(AppLive(...)))` from `_shared/runtime.ts`. Do NOT hold a module-scoped `let runtime` - the registry owns singleton storage.
5. **`facade.ts`** - exports a `<Name>Facade` class (or singleton) whose methods return Promises. Each method runs an Effect on `getRuntime()` and converts the resulting `Exit` into either a plain value or a discriminated `{ success: true, ... } | { success: false, errorCode, error, details? }` envelope.

## Facade pattern

Two flavors of facade method:

- **"Plain" methods** return the success value or `null` (used for read-only / no-fail operations like `getRun(sessionId): Promise<Snapshot | null>`).
- **"Envelope" methods** return `Envelope<A>` where `A` is the success type and the failure case carries `errorCode` (the Effect error's `_tag`) plus a human-readable `error` string. Used for any operation that can fail with a typed error the caller needs to discriminate.

The reference implementation in `bash/facade.ts` shows both:

- `run(...)` returns `RunEnvelope` (envelope flavor).
- `getRun(...)` returns `BashRunSnapshot | null` (plain flavor).

Use `fromCause(cause)` from `src/main/services/error-utils.ts` when converting
Effect failures into envelope failures.

## Import-boundary rule

**The only files outside `src/main/effect/<island>/` may import from are:**

1. `src/main/effect/<island>/facade.ts` - the public facade.
2. `src/main/effect/_shared/*` - shared helpers (runtime registry, zod adapter, future utilities).

**They MUST NOT import from:**

- `src/main/effect/<island>/service.ts`
- `src/main/effect/<island>/layers.ts`
- `src/main/effect/<island>/errors.ts`
- `src/main/effect/<island>/runtime.ts`
- `src/main/effect/<island>/types.ts` (unless the type is genuinely cross-cutting - re-export from the facade if so)

If you find yourself wanting to import an internal Effect type into a non-Effect file, that's a signal the facade needs a new method or a new return type, not a deeper import.

This is enforced by code review for now. An ESLint rule may be added later if drift becomes a problem.

## Shared infrastructure

- **`_shared/runtime.ts`** - `getOrCreateRuntime(name, factory)`, `disposeRuntime(name)`, `disposeAllRuntimes()`. Islands MUST use this; do not create a `ManagedRuntime` outside.
- **`_shared/zod-adapter.ts`** - `decodeWithZod(schema, input, schemaName?)` and `ZodDecodeError`. Use at every external input boundary (IPC payloads, SDK responses, settings).

The `db/` island (`src/main/effect/db/`) provides the `Db` service tag
(`query`/`queryOne`/`exec`/`transaction`/`raw`) and tagged DB errors. See
`src/main/effect/db/service.ts` and the worktree consumer in
`src/main/services/worktree-ops.ts` for an end-to-end example.

## Test conventions

Use the helpers in `test/utils/effect-test-utils.ts`:

- `runEffect(effect)` -> `Promise<Exit<A, E>>`.
- `expectExitSuccess(exit)` -> unwraps the success value or throws.
- `expectExitFailure(exit, '<Tag>')` -> asserts the failure tag and returns the typed error.
- `withTestLayers(...overrides)` -> `Layer.mergeAll` wrapper for composing test layer overrides.

Use `Effect.provide(Layer.provide(<Live>, withTestLayers(...)))` to inject fakes for the island's external dependencies (event sinks, spawners, DB connections, etc.).

`TestClock` from `effect` substitutes for real time in tests - see `bash/__tests__/bash-service.effect.test.ts:83` for an example.

## IPC migration recipe (Session 3)

Channels migrated to `defineHandler` (`src/main/ipc/_shared/define-handler.ts`)
get input validation, an Effect-typed handler body, and a `Envelope<A>` return
in three steps. Reference: `src/main/ipc/file-handlers.ts` (`file:write`,
`file:readImageAsBase64`) and `src/main/ipc/git-file-handlers.ts`
(`git:discardChanges`).

### 1. Define the input schema (Zod 4)

- Single-arg call: `z.string()`, `z.object({...})`, etc. - the renderer's lone
  argument is decoded directly.
- Multi-arg call: `z.tuple([...])` - `defineHandler` packs `args` into a tuple
  when the renderer sends 2+ positional arguments.

```ts
const Schema = z.tuple([z.string().min(1), z.string()])
```

### 2. Write the handler Effect

The handler returns `Effect.Effect<A, E, never>`. `A` is the success payload
(plain JSON), `E` is a `Data.TaggedError(...)` whose `_tag` becomes the
envelope's `errorCode`. Wrap legacy services with `Effect.suspend` (sync) or
`Effect.tryPromise` (async).

```ts
class FileWriteFailed extends Data.TaggedError('FileWriteFailed')<{
  readonly filePath: string
  readonly reason: string
}> {}

const writeEffect = ([path, content]: [string, string]) =>
  Effect.suspend(() => {
    const r = writeFile(path, content)
    return r.success
      ? Effect.succeed(null)
      : Effect.fail(new FileWriteFailed({ filePath: path, reason: r.error ?? 'Unknown' }))
  })
```

### 3. Register

```ts
defineHandler('file:write', Schema, writeEffect)
```

### 4. Renderer side

Update the matching entry in `src/preload/index.ts` and `src/preload/index.d.ts`
to return `Promise<Envelope<A>>`. At call sites, narrow on `envelope.success`:

```ts
const envelope = await window.fileOps.writeFile(path, content)
if (!envelope.success) {
  // envelope.errorCode  -> discriminant for retry/UI logic
  // envelope.error      -> human message for toasts
  // envelope.details    -> typed-error fields (filePath, reason, etc.)
  return
}
const value = envelope.value // typed as A
```

### 5. Tests

Use the Map-backed `ipcMain` mock (see
`src/main/ipc/_shared/__tests__/define-handler.test.ts`):

```ts
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((c, h) => handlers.set(c, h)) },
  app: { getPath: vi.fn(() => '/tmp') }
}))
// ...register handlers, then:
const result = await handlers.get('file:write')!(mockEvent, path, content)
```

### Ground rules

- **Pure JSON in `Envelope.value`.** No `BrowserWindow`, no class instances.
  Structured-clone runs at the IPC boundary.
- **Don't mass-migrate.** Each PR migrates a small slice; rest stay legacy
  until Session 8.
- **One runtime per island.** `defineHandler` uses the shared `'ipc'` runtime
  (`getIpcRuntime`). Island-backed handlers pre-`Effect.provide(...)` their
  layers before reaching `defineHandler`.

## TestClock for time-dependent Effects

Use `TestClock` for any Effect test that depends on time: `Effect.timeout`,
`Effect.sleep`, `Schedule.exponential`, retry backoff, debounce windows, or
polling loops. Tests should advance virtual time instead of waiting on real
timers.

The helper `runEffectWithTestClock` in `test/utils/effect-test-utils.ts` runs
an Effect with the test clock available. Pair it with `Fiber` when the Effect
must start first and complete only after time is advanced.

```ts
import { Effect, Fiber, TestClock } from 'effect'
import {
  expectExitSuccess,
  runEffectWithTestClock
} from '../../../../../test/utils/effect-test-utils'

it('completes after virtual time advances', async () => {
  const exit = await runEffectWithTestClock(
    Effect.gen(function* () {
      const fiber = yield* Effect.sleep('30 seconds').pipe(
        Effect.as('done'),
        Effect.fork
      )

      yield* TestClock.adjust('30 seconds')

      return yield* Fiber.join(fiber)
    })
  )

  expect(expectExitSuccess(exit)).toBe('done')
})
```

The bash service test is the canonical worked example for time-dependent
Effect tests.

## Layer-override pattern (per-island example tests)

Each island test should override only the services it needs to fake. The fake
service should match the island's `Context.Tag` shape from `service.ts`, then be
provided with `Layer.succeed` for simple objects or `Layer.effect` when setup
itself is an Effect.

```ts
const fakeDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  exec: vi.fn(),
  transaction: <A, E, R>(self: Effect.Effect<A, E, R>) => self,
  raw: Effect.die('raw is not provided in this test')
}

const TestDbLive = Layer.succeed(Db, fakeDb)

const exit = await runEffect(
  program.pipe(
    Effect.provide(TestDbLive),
    Effect.either
  )
)
```

For success and typed-failure assertions, use `runEffect` with
`expectExitSuccess` / `expectExitFailure`, or `Effect.either` when the test
wants to assert on `Either` directly inside the Effect graph.

Session 8 adds `db/__tests__/db-layer-override.example.test.ts` as the
heavily-commented copy-from template for this pattern.

## IPC handler migration: defineHandler may import island internals

The import-boundary rule has one narrow exception: IPC handler modules that use
`defineHandler` MAY import an island's `service.ts` Tags and `layers.ts` Live so
the handler can provide island services before registration.

IPC handlers MUST NOT import island `errors.ts` or `runtime.ts`. Typed errors
should be defined at the IPC boundary or returned through the island facade, and
runtime ownership stays inside the island or `_shared/runtime.ts`.

See `src/main/ipc/git-file-handlers.ts` for the git-file handler migration
shape.

## Coverage

Run coverage with:

```bash
pnpm test:coverage
```

Vitest prints a terminal summary and writes detailed reports under
`coverage/`, including HTML and lcov output. Coverage configuration lives in
`vitest.config.ts` and is shared by workspace projects through `extends` in
`vitest.workspace.ts`.

Coverage thresholds are intentionally set to `0` for now. The goal is to make
coverage visible before ratcheting thresholds upward.
