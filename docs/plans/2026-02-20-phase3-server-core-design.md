# Phase 3 — Server Core: Design Validation & Implementation Strategy

**Date:** 2026-02-20
**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan:** `docs/plans/mobileapp-implementation.md`
**Detailed Plan:** `docs/plans/mobileapp-implementation-phase3.md`
**Scope:** Sessions 19–31 (all of Phase 3)

## Prerequisites Verified

- Phase 1 complete: EventBus (`src/server/event-bus.ts`), shared types (`src/shared/types/`), all dependencies installed
- Phase 2 complete: GraphQL schema (1027 LOC across 11 `.graphql` files), codegen producing `resolvers-types.ts` (2891 LOC)
- All tests passing, build succeeds

## Design Decisions

### 1. TLS Certificate Generation
Use `openssl` via `child_process.execSync` rather than a Node.js X.509 library. Simpler, available on macOS/Linux, avoids additional dependencies.

### 2. Vitest Configuration
Server tests (`test/server/`) need `node` environment, not `jsdom`. Add `// @vitest-environment node` headers or update workspace config as a pre-requisite before any test files.

### 3. Existing `context.ts`
`src/server/context.ts` already exists as an incomplete stub from Phase 2. Complete it rather than create from scratch.

### 4. Resolver Merger
Start with empty `{}` in `src/server/resolvers/index.ts`. Structure for easy import/spread of individual resolver files in Phase 4+.

## Implementation Strategy: Parallel Batches

Sessions grouped by dependency layer. Independent modules built in parallel.

| Batch | Sessions | Files Created | Tests |
|-------|----------|--------------|-------|
| **Layer 0: Pre-req** | Vitest config fix | Config update | — |
| **Layer 1: Foundation** | 19 (context) + 22 (auth keys) + 26 (path guard) + 27 (TLS) + 28 (config) | 5 source files | 4 test files |
| **Layer 2: Plugins** | 23 (auth plugin) + 24 (brute force) | Additions to `auth.ts` | 2 test files |
| **Layer 3: Server** | 20 (server entry) + 25 (WS auth) + resolver merger | 2 source files | 1 test file |
| **Layer 4: Bootstrap** | 21 (headless bootstrap) | 1 source file | — |
| **Layer 5: CLI** | 29 (flags) + 30 (startup branch) + 31 (mgmt commands) | Modifications to `index.ts` | — |

### Layer Dependencies

```
Layer 0 (vitest config)
  └── Layer 1 (context, auth keys, path guard, TLS, config) — all parallel
        └── Layer 2 (auth plugin, brute force) — depend on auth keys
              └── Layer 3 (server entry, WS auth) — depend on auth plugin + context
                    └── Layer 4 (headless bootstrap) — depends on server + config + TLS + auth
                          └── Layer 5 (CLI integration) — depends on everything
```

## Files Created (Phase 3)

```
src/server/
  context.ts                  — Complete GraphQLContext interface
  index.ts                    — startGraphQLServer() with yoga + HTTPS + WS
  headless-bootstrap.ts       — headlessBootstrap() + handleManagementCommand()
  config.ts                   — loadHeadlessConfig() with defaults + deep merge
  tls.ts                      — generateTlsCerts(), getCertFingerprint(), ensureTlsCerts()
  plugins/
    auth.ts                   — API key gen/hash/verify, auth plugin, brute force tracker
    path-guard.ts             — PathGuard class + yoga plugin
  resolvers/
    index.ts                  — Empty resolver merger (placeholder)

test/server/
  auth-key.test.ts
  auth-plugin.test.ts
  auth-brute-force.test.ts
  auth-ws.test.ts
  path-guard.test.ts
  tls.test.ts
  config.test.ts
```

## Files Modified

| File | Change |
|------|--------|
| `src/main/index.ts` | ~25 lines: CLI flag parsing + headless startup branch + management commands |
| Vitest config | Server test environment setup |

## Verification

Each layer verified with `pnpm build` and running its test files. Full `pnpm build && pnpm test` after Layer 5.
