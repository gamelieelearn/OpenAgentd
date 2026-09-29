# Backend Guide (v2, source only)

Python `>=3.14` backend. This subtree contains the FastAPI app, CLI, agent
runtime, SQLModel persistence, scheduler, and migrations. It is the
end-of-life v2 backend, kept as source-only reference: releases and the
desktop sidecar ship the Rust backend in `appv3/` (see `appv3/AGENTS.md`),
which keeps v2's wire and on-disk formats. The repository no longer carries
v2 packaging, tests, or CI, so nothing here is built or run from this checkout.

## Ownership

- `api/`: HTTP/SSE assembly, request validation, dependencies, and response
  shaping. Durable behavior does not belong in route handlers.
- `services/`: application behavior shared by routes, CLI, scheduler, or the
  agent runtime.
- `agent/`: provider, tool, MCP, permission, prompt, and single-agent runtime.
- `core/`: configuration, paths, database/session factories, auth, logging,
  and telemetry primitives.
- `models/` and `scheduler/models.py`: persisted SQLModel tables.
- `cli/`: the `openagentd = app.cli:main` command and subcommands.
- `migrations/`: Alembic environment and ordered schema revisions.

Use absolute imports from `app`. Backend modules consistently use
`from __future__ import annotations`, `|` unions, typed signatures, Pydantic v2,
and loguru placeholder formatting such as `logger.info("event key={}", value)`.
External provider payload models use the existing permissive
`ConfigDict(extra="ignore")` pattern where forward-compatible fields are
expected.

## Constraints

- Treat this tree as the reference v3 ports from. Make behavior changes in
  `appv3/` and record deliberate deviations from v2 in `appv3/REPORT.md`.
