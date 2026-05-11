# Effect Island

This directory is a contained pilot for adopting `effect` in the Electron main process. It is deliberately isolated from `src/main/services` so the experiment can be evaluated and deleted as a unit.

## Scope

- Only the bash service lives here.
- No renderer code, IPC bridge types, Zustand stores, or React components should import Effect types.
- Do not add other services to this island without re-evaluating the pilot criteria.
- No `@effect/platform` or `@effect/schema` in this pilot.

The public boundary remains the existing bash-service facade: callers get promises and the current IPC envelope shape.

## Why This Exists

The pilot tests whether Effect improves four concrete pain points in this service:

- Typed errors at the IPC boundary.
- Testability through Layer-based dependency injection.
- Resource safety for child processes, listeners, timers, and shutdown.
- Streaming plus cancellation for bash output and abort behavior.

## Kill Criteria

Evaluate 30 days after the Effect implementation ships to canary.

The pilot succeeds if all of these are true:

- Zero P0/P1 bug reports tagged `bash`.
- Effect-version LOC is at most 110% of the original bash service. Original: 431 LOC. Budget: 474 LOC.
- At least two of the four motivations show measurable wins:
  - At least one typed error path is covered by a test that did not exist before.
  - Zombie-process count after `killAll` is 0 across 100 stress runs.
  - The TestClock-driven abort escalation test runs in under 50 ms.
  - Abort latency p95 stays within 50 ms of the previous baseline.
- A teammate other than the author lands an unrelated PR touching this island without help.

The pilot fails and should be reverted if any of these happen:

- One or more P0 incidents are traceable to Effect semantics such as interruption, scope, or runtime behavior.
- LOC exceeds 130% of the original and no runtime or test wins materialize.
- Two reviewers independently report they cannot debug an issue inside the island within 30 minutes.
- Main-process bundle size increases by more than 500 KB.

## Boundary Rule

Effect stays inside this directory. Export plain TypeScript types and promise-returning facade methods at the boundary.
