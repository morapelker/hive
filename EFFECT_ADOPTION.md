# Effect Adoption Plan

This document describes how we incrementally adopt [Effect](https://effect.website/) across the Hive codebase. It is broken into 8 medium-sized sessions, each scoped to ~3–5 days and one PR.

## Goals (in priority order)

1. **Typed errors at every layer**: replace `unknown`-typed `try/catch` and `{ success, error? }` envelopes with `Effect.Effect<A, E>` where `E` is a discriminated union of `Data.TaggedError` instances.
2. **Type-safety at boundaries**: every value crossing a process/IPC/SDK boundary is validated with **Zod 4** before reaching business logic.
3. **Robustness primitives**: timeouts, retries with backoff, cancellation, and resource cleanup composed via Effect's combinators (`Effect.timeout`, `Effect.retry` + `Schedule`, `Effect.scoped`, fiber interruption) instead of hand-rolled `setTimeout`/`AbortController`.
4. **Testing viability**: `Layer.succeed`-based dependency overrides, `TestClock` for time-dependent code, and `Exit`-based assertions replace ad-hoc `vi.mock` chains.

## Ground rules

- **Scope**: main process + preload + a thin Effect adapter inside renderer hooks. React components and Zustand stores stay vanilla TS — they consume plain values returned from preload.
- **Schemas**: **Zod 4** is the only validation library. We do not introduce `@effect/schema`. A `decodeWithZod` adapter lifts Zod failures into tagged Effect errors.
- **Coexistence**: Effect lives in `src/main/effect/<subsystem>/` islands. Each island exposes a thin Promise-returning façade (see `bash/facade.ts`) so the rest of the codebase can keep calling it as before during migration.
- **Canonical pattern**: every island follows `errors.ts` → `service.ts` (Context.Tag) → `layers.ts` (Live impl) → `runtime.ts` (ManagedRuntime) → `facade.ts` (Promise envelope) + `__tests__/`. The existing `src/main/effect-island/bash/` is the reference.

## Boundary contract (referenced by every session)

The IPC boundary serializes Effect outcomes as a discriminated envelope:

```ts
type Envelope<A> =
  | { success: true; value: A }
  | { success: false; errorCode: string; error: string; details?: unknown }
```

`errorCode` is the Effect error's `_tag`. The renderer never sees an `Effect`; it only sees this envelope (or unwraps it inside an Effect-aware hook).

---

## Session 1 — Foundation: Zod 4 upgrade, Effect conventions, shared runtime & test utilities

- [ ] **Done**

**Deliverables**

- Bump `zod` from `3.25.76` to latest `^4.x` and resolve breaking changes across all ~83 usages.
- Promote `src/main/effect-island/` → `src/main/effect/` with one subdirectory per island; `bash/` becomes the first inhabitant.
- Add `src/main/effect/_shared/runtime.ts` — a single `ManagedRuntime` registry the whole main process uses (replaces per-island singletons).
- Add `src/main/effect/_shared/zod-adapter.ts` exposing `decodeWithZod<A>(schema, input): Effect.Effect<A, ZodDecodeError>` where `ZodDecodeError extends Data.TaggedError("ZodDecodeError")<{ issues, schemaName }>`.
- Add `test/utils/effect-test-utils.ts`: `runEffect`, `expectExitSuccess`, `expectExitFailure(_tag)`, plus a `withTestLayers(...overrides)` helper.
- Add a CONVENTIONS section to `docs/` (or top of `effect/_shared/README.md`) describing the island pattern, layering rules, and how to expose a façade.
- ESLint rule (or simple import boundary doc): code outside `effect/<island>/` must import only from `<island>/facade.ts`.

**Watch out for**

- **Zod 4 breaking changes**: `.error` is removed in favor of `.issues`; `z.preprocess` semantics tightened; `.nonempty()` returns `[T, ...T[]]`; `enum` typing changed. Run `pnpm exec tsc -p tsconfig.node.json` and `tsconfig.web.json` after the bump and triage in batches.
- **Codex schema generator**: `pnpm codex:generate-schemas` produces Zod files under `src/shared/codex-schemas/` — the generator's output may need updating; verify with `pnpm probe:codex-app-server`.
- The existing bash island already has its own `runtime.ts` — refactor it to consume the shared registry rather than holding its own singleton, but keep its public façade signatures unchanged.
- Don't try to migrate any *callers* in this session; this is foundation only. PR diff should look almost entirely additive plus the Zod bump.
- Verify both vitest workspaces (`renderer` and `node`) still pass after the Zod bump.

---

## Session 2 — Logger Layer & shared error vocabulary

- [ ] **Done**

**Deliverables**

- Wrap `createLogger` (`src/main/services/logger.ts`) as an Effect `Logger` and expose it as a `Layer` mounted into the shared runtime so Effect code uses `Effect.log{Info,Warn,Error}` and the output flows into the existing rotating file log.
- Add `src/main/effect/_shared/errors.ts` with cross-cutting tagged errors: `ZodDecodeError`, `IpcSerializationError`, `TimeoutError`, `CancelledError`, `UnexpectedDefect`. These are reused by every later session.
- Migrate `src/main/effect-island/bash/` (now `effect/bash/`) to use the Logger Layer rather than importing `createLogger` directly — proves the pattern.
- Update `src/main/services/error-utils.ts`: keep `toError()` for the legacy world, but add `fromCause(cause): { errorCode, error, details }` that any island façade can use to render `Cause.Cause<E>` into the IPC envelope (the bash island's `toEnvelope` becomes a thin wrapper around this).

**Watch out for**

- Effect's `Logger` API uses fiber-local context; if the existing logger has component tags (it does — it takes a tag in `createLogger("BashService")`), thread that tag through `Logger.withMinimumLogLevel`/`Logger.add` rather than building a brand-new tag-per-call API.
- The renderer also has its own logger surface — don't try to wrap that here. Renderer logging stays vanilla.
- Don't mass-migrate the 40 `createLogger(...)` callers; only Effect code uses the new Layer. Legacy `createLogger` continues to work.
- Verify log file rotation still happens (5 MB, 5 files) — write a small Effect, run it, and check `~/Library/Application Support/hive/logs/`.

---

## Session 3 — IPC boundary: `defineHandler` + Zod validation + error envelope

- [ ] **Done**

**Deliverables**

- Add `src/main/ipc/_shared/define-handler.ts` exporting:
  ```ts
  defineHandler<I, A, E>(
    channel: string,
    inputSchema: z.ZodType<I>,
    handler: (input: I) => Effect.Effect<A, E, AppRuntime>,
  ): void
  ```
  It registers an `ipcMain.handle` that: parses input via `decodeWithZod`, runs the Effect on the shared runtime, returns the `Envelope<A>`.
- Migrate **3 representative IPC handlers** to the new pattern as a vertical slice (suggest: one read-only file op, one git op from `git-file-handlers.ts`, one mutating op). Leave the other ~21 handlers on the legacy pattern for now.
- Update `src/preload/index.ts` types so the renderer sees the `Envelope<A>` discriminated union for migrated channels.
- Document the migration recipe in `effect/_shared/README.md` (input schema → handler Effect → env decoded by preload).

**Watch out for**

- Don't break existing channels. The new `defineHandler` registers via `ipcMain.handle` exactly like before; the change is internal.
- IPC payloads contain class instances (e.g., `BrowserWindow` references) that don't survive structured-clone — ensure the `Envelope.value` is plain JSON.
- `Cause.failureOption` returns `None` for defects (uncaught throws inside the Effect). The envelope already handles this with `errorCode: "Defect"` (see `bash/facade.ts:44`); reuse that path.
- Renderer-side type for migrated channels changes from `Promise<T>` to `Promise<Envelope<T>>`. Pick channels for this slice that have ≤ 2 renderer call sites so the renderer touch-up is tiny — defer the mass migration to Session 8.
- Test the slice end-to-end with the existing vitest harness in `test/phase-21/session-6/ipc-model-routing.test.ts` style (Map-backed `ipcMain` mock).

---

## Session 4 — Child-process / spawn services

- [ ] **Done**

**Deliverables**

- New island `src/main/effect/spawn/` exposing a generic `Spawn` service: `runOnce({ command, args, cwd, timeout })`, `stream({ ... })`. Reuses the bash island's `Spawner` Tag concept but is generic across CLI launches.
- Tagged errors: `SpawnFailed`, `SpawnTimeout`, `SpawnNonZeroExit`, `SpawnSignalled`.
- Migrate `src/main/services/title-generation-shared.ts` (the manual `setTimeout`-based timeout at lines 176–296) to use `Effect.timeout` + `Effect.scoped` for guaranteed kill-on-cancel.
- Migrate the codex/opencode/claude CLI launch sites that today use bare `spawn`/`exec` (audit with grep for `child_process`).
- Update the existing bash island to delegate process management to the new generic `Spawn` service (its sessions/serial-ization stays in `bash/`).

**Watch out for**

- `Effect.scoped` + `Scope.addFinalizer` is how you guarantee `proc.kill('SIGTERM')` runs on cancellation. Don't try to replicate this with `try/finally`.
- macOS process groups: `signalTree` in the existing bash island already handles tree-killing — port that logic; don't regress it.
- Stdout/stderr buffering: Effect Streams give you back-pressure for free. For commands that produce lots of output, prefer streaming over buffer-then-resolve.
- Title generation has a 30-second timeout today — preserve that exact behavior; don't accidentally tighten it.
- Some callers ignore stderr; some need it. Make the API explicit (`{ collectStderr: true }`) rather than guessing.
- Run `pnpm test` and especially the title-generation tests in `test/title-generation.test.ts` to confirm parity.

---

## Session 5 — Git service migration

- [ ] **Done**

**Deliverables**

- New island `src/main/effect/git/` wrapping `simple-git` and any direct `git` shell-outs from `src/main/services/git-service.ts`.
- Replace `{ success: boolean; error?: string }` result envelopes with typed Effects. Tagged errors: `GitNotARepository`, `GitDirty`, `GitMergeConflict`, `GitNetworkError`, `GitPermissionDenied`, `GitUnknown`.
- Façade signatures stay backwards-compatible (return the legacy envelope on the outside) so callers don't have to change in this PR.
- Migrate the 3 IPC handlers chosen in Session 3 if any of them are git-related; otherwise migrate `git-file-handlers.ts` here as the consumer slice.

**Watch out for**

- `simple-git` already throws — wrap it via `Effect.tryPromise` and classify the thrown error into a tagged error using the message (yes, ugly, but `simple-git`'s error model is opaque). Build the classifier as a small pure function with unit tests so regressions are caught.
- Worktree-aware paths: many ops take a `cwd` that must be the worktree, not the project root. Don't drop this — it's already correct in the legacy code; mirror it.
- BranchWatcher (`chokidar` over `.git/`) is event-driven and pre-dates Effect. Don't try to convert it in this session — it's its own concern.
- Concurrent git commands on the same repo can conflict. Use `Effect.semaphore` per-repo if you find races.
- Snapshot the legacy behavior with a few characterization tests *before* migrating, then port them.

---

## Session 6 — Streaming subsystems: OpenCode, Claude, Codex

- [ ] **Done**

**Deliverables**

- New islands `src/main/effect/opencode/`, `effect/claude/`, `effect/codex/` (or one shared `effect/agents/` if the SDK shapes converge).
- Convert SDK event subscriptions in `src/main/services/opencode-service.ts:53` (the `AbortController`-driven subscription loop) into `Stream<SdkEvent, AgentError>`.
- Use `Effect.retry(Schedule.exponential("100 millis").pipe(Schedule.jittered))` for connection failures (today: ad-hoc retry in opencode-service).
- Cancellation via fiber interruption (replaces the manual `AbortController` plumbing). The IPC handler holds the fiber handle; abort = `Fiber.interrupt`.
- Validate every SDK response payload through Zod 4 schemas (`decodeWithZod`) before it enters business logic — today most go in unchecked (see `opencode-service.ts:491-498`).

**Watch out for**

- These services are the **largest single file** in the project (`opencode-service.ts` is dense). Do *not* try to port everything at once — pick one streaming API surface (e.g., session events) per island and prove it; leave the rest behind a feature flag toggle until follow-up work.
- The renderer subscribes to forwarded SDK events via IPC. The `Stream` → IPC bridge needs to be careful about ordering: Effect Streams are pull-based, IPC is push-based. Use `Stream.runForEach((evt) => Effect.sync(() => mainWindow.webContents.send(channel, evt)))` and respect back-pressure.
- Don't migrate `text-generation-router.ts` routing logic in this session — keep it as a thin selector that returns the right Effect island façade.
- AgentEventBus is a global EventEmitter — leave it alone for now; islands publish to it via a small adapter.
- Test with the existing `test/phase-21/session-3/claude-lifecycle.test.ts` and `claude-abort.test.ts` patterns; adapt them to the Effect runtime via `runEffect`/`expectExitSuccess`.

---

## Session 7 — Database Layer

- [ ] **Done**

**Deliverables**

- New island `src/main/effect/db/` wrapping `better-sqlite3` from `src/main/db/database.ts`.
- `Db` Service Tag exposing: `query`, `queryOne`, `exec`, `transaction(self => Effect)`. The transaction combinator runs its body in an Effect; commit/rollback is automatic on success/failure/interruption.
- Tagged errors: `DbConstraintViolation`, `DbForeignKeyViolation`, `DbBusy`, `DbCorrupt`, `DbUnknown`.
- Migrate **one** consumer (recommend: the `worktrees` table operations) end-to-end as the proof. Leave `projects`, `sessions`, schema migrations on the legacy path.

**Watch out for**

- `better-sqlite3` is **synchronous**. Wrap calls with `Effect.sync` (not `Effect.tryPromise`); throw classification is via `Effect.try({ try, catch })`.
- The DB connection is a process-wide singleton initialized at app start; the Layer should not own the connection lifecycle (don't dispose it on Layer release). Use `Layer.effect` reading from the existing global, not `Layer.scoped`.
- Schema version is at v26 (`src/main/db/`); the migration runner must stay on the legacy path — don't try to Effect-ify schema migrations.
- Test using the existing `test/utils/db-test-utils.ts` (temp SQLite file) but inject via a test Layer override rather than module mocking.
- Watch for transaction semantics: `better-sqlite3.transaction(...)` is a synchronous callback — wrapping it in async Effect requires care so the Effect's interruption can roll back.

---

## Session 8 — Renderer hook bridge & test infrastructure consolidation

- [ ] **Done**

**Deliverables**

- Add `src/renderer/src/lib/effect/` with a tiny `runIpcEffect<A>(envelope: Promise<Envelope<A>>): Effect.Effect<A, IpcError>` adapter so renderer hooks that orchestrate multiple IPC calls can compose them with retry/cancellation.
- Migrate **one or two** complex renderer hooks (suggest: a hook in `src/renderer/src/hooks/` that today chains 2+ IPC calls with manual error handling) to use the adapter. Leave the rest alone.
- Mass-migrate the remaining ~21 IPC handlers from Session 3's slice to `defineHandler` (mostly mechanical at this point).
- Stand up `test/utils/effect-test-utils.ts` v2: add `TestClock`, `TestRandom`, `withTestLayers(...)` examples; document patterns in `effect/_shared/README.md`.
- Add coverage tooling (`@vitest/coverage-v8`) and a `pnpm test:coverage` script. Set a baseline threshold (no enforcement yet).
- Author 1 example test per Effect island demonstrating layer-override mocking, so future contributors have a copy-from template.

**Watch out for**

- Zustand stores must remain vanilla — do not introduce Effect into stores. The adapter is for hooks that *prepare* data before storing it.
- React 19 + Effect: do not call `Effect.runPromise` during render. Hooks must run effects in `useEffect` / event handlers.
- The mass IPC handler migration will produce a large diff — break it into 3–4 commits within the same PR if needed for review.
- Coverage tooling on Electron: the `node` workspace covers main; the `renderer` workspace (jsdom) covers renderer. Configure `coverage.include` per workspace to avoid double-counting `src/shared/`.
- Verify Playwright e2e (`pnpm test:e2e`) is unaffected — the Effect changes are behind façades that preserve old call signatures.

---

## After Session 8

Remaining work (NOT scoped here, deliberately): full migration of all IPC handlers' renderer call sites away from the legacy `Promise<T>` shape, removal of the old `bash-service.ts`, BranchWatcher Effect-ification, and migration of the schema-migration runner. Track these in follow-up tickets once the eight sessions land and the patterns are proven.

## Reference: file-by-file pointers

- Canonical island pattern: `src/main/effect-island/bash/{errors,service,layers,runtime,facade}.ts`
- Logger to wrap: `src/main/services/logger.ts`
- IPC entry registry: `src/main/ipc/index.ts`
- Spawn callers: grep `child_process` under `src/main/services/`
- Title-generation timeout to migrate: `src/main/services/title-generation-shared.ts:176-296`
- Git result-envelope to migrate: `src/main/services/git-service.ts`
- Streaming subsystem: `src/main/services/opencode-service.ts:53,491-498`
- DB wrapper: `src/main/db/database.ts`
- Test workspaces: `vitest.workspace.ts`
- Test setup: `test/setup.ts`, `test/utils/db-test-utils.ts`
