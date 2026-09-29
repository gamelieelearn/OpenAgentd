# Debug reference: Backend / API / agent / provider

Use when the symptom is in API routes, persistence, queueing, SSE streaming, agent loops, tool execution, or provider calls. The shipped backend is the Rust workspace in `appv3/`; `app/` is the source-only v2 code it ports.

---

## Evidence commands

```bash
openagentd server status                          # port, live, ready, and LAN checks
openagentd server logs                            # readable server log lines
curl -fsS http://127.0.0.1:8000/api/health/ready  # readiness from a source checkout (`make run`)
```

For log files and OTEL telemetry analysis, load `oad/debug-prod`.

---

## File map

```
appv3/crates/
  api/        axum routes (src/routes/), middleware (auth, Origin/Host guard, CORS), startup
  agent/      turn loop, hooks, sessions, SSE broadcaster + stream store, scheduler
  db/         SQLite pool, v2-compatible queries, migrations (resources/migrations/)
  providers/  LLM provider adapters
  tools/      built-in agent tools
  core/       settings, XDG paths, auth policy (src/auth.rs), path safety
  cli/        `openagentd` binary; `server serve` is the sidecar entry point
appv3/contract/sse_events.json   SSE event contract shared with web
appv3/REPORT.md                  deliberate differences from v2
```

---

## Common failure boundaries

| Boundary | What to inspect |
|---|---|
| Route validation | handler in `api/src/routes/`, HTTP status returned |
| Persistence | `db/` queries and migrations |
| Queueing / ordering | `agent/` stream store, SSE event emission order |
| Agent loop | `agent/` turn loop, tool dispatch, compaction |
| SSE stream | `agent/src/events.rs`, `appv3/contract/sse_events.json`, client reconnect behavior |
| Provider call | `providers/` adapter, env vars, retry/timeout config |
| Desktop auth | `core/src/auth.rs`, `api/src/middleware.rs`, sidecar handshake |

---

## Verification

```bash
make verify-v3                                                         # fmt, clippy -D warnings, all tests
cargo test --manifest-path appv3/Cargo.toml -p appv3-api --test http_api  # focused
```
