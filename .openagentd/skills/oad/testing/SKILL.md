---
name: oad/testing
description: >
  OpenAgentd testing reference — environment setup, run commands, and fix
  patterns for backend (cargo) and frontend (Bun/RTL). Load this for
  running, fixing, or adding coverage to existing tests. For writing a
  failing test before new code, use oad/test-driven-development instead.
---

# When to load which skill

| Situation | Skill |
|---|---|
| Running or fixing existing tests | **this skill** |
| Adding coverage for already-written code | **this skill** |
| Writing a failing test *before* implementing new behavior | `oad/test-driven-development` (loads this automatically) |
| Reproducing a bug with a test before fixing | `oad/test-driven-development` (Prove-It pattern) |

---

# Backend (v3, Rust / cargo test)

## Run commands

```bash
make verify-v3                                                           # fmt check, clippy -D warnings, all tests
cargo test --manifest-path appv3/Cargo.toml -p appv3-api                 # one crate
cargo test --manifest-path appv3/Cargo.toml -p appv3-agent --test session_turn  # one integration file
cargo test --manifest-path appv3/Cargo.toml -p appv3-agent <name_filter> # tests matching a name
```

## Environment rules

- Integration tests that spawn `server serve` (`appv3/crates/cli/tests/`) build the binary and use throw-away `HOME`/XDG roots — never point tests at real user data.
- Timing-dependent async tests use `#[tokio::test(start_paused = true)]` instead of real sleeps.
- API or SSE event changes also need `make verify-web`; event types must match `appv3/contract/sse_events.json`.

## Placement

Unit tests go in a `#[cfg(test)] mod tests` beside the code. Behavior that crosses modules goes in `appv3/crates/<crate>/tests/<topic>.rs` (e.g. `crates/api/tests/http_api.rs`).

---

# Frontend (Bun / React Testing Library)

## Run commands

```bash
cd web && bun test --parallel         # full suite
cd web && bun test src/__tests__/path/to/Foo.test.tsx  # single file
```

## Environment rules

- `afterEach(cleanup)` in every component test file.
- Mock `lucide-react` at the top of every component test file:
  `mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))`.
- `mock.module()` patches the global Bun module registry and is not undone by `mock.restore()` — always run with `--parallel` so files get their own worker. Place any `mock.module()` call **before** the import of the code that uses it.
- Store tests reset state in `beforeEach` (`useXStore.setState(INITIAL)`).
- Prefer firing real store actions/SSE handlers over asserting on mocked internals (e.g. `useAgentStore.getState()._handleSSEEvent(...)`, then read `getState()` back).

## Placement

`web/src/components/Foo.tsx` → `web/src/__tests__/components/Foo.test.tsx`

---

# Desktop (Rust / Tauri / cargo test)

Read the surface-specific reference for commands and gotchas:

```
read("<skill_dir>/reference/rust-tauri.md")
```

---

# Writing good tests (applies to all surfaces)

- **Assert on outcome, not internals.** Check returned/rendered state, not which method was called.
- **DAMP over DRY.** Each test reads standalone — some duplication across test bodies is fine.
- **Real implementation > fake > stub > mock.** Mock only at slow, non-deterministic, or external boundaries.
- **One behavior per test**, named as a spec: `sets completedAt when task is completed`, not `works`.
- **Never sleep for real delays** — use paused tokio time or fake timers, or drive the event you are waiting on.

# Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Testing implementation details (mock call assertions) | Assert on state/output |
| Flaky tests (order/timing-dependent) | Isolate state; patch delays, never sleep |
| Mocking everything | Prefer real fixtures; mock only slow/non-deterministic boundaries |
| Bug fix with no reproduction test | Use `oad/test-driven-development` Prove-It pattern |
| Skipping a failing test to get green | Fix it or track it explicitly, never silently skip |

# Test pyramid

```
    Integration tests — API route + DB (crate tests/), component + store (mirrored path)
   Unit tests — pure functions, isolated hooks/modules — most of the suite
```

- Most new tests should be unit: no DB, no network, milliseconds each.
- Cross a boundary → integration test, prefer real fixtures over mocks.
