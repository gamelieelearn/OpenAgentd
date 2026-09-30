# MCP servers

MCP servers are global: every enabled, ready server's tools are attached to the
lead agent automatically as `<server>_<tool>`. Members get no MCP tools. Don't
add `mcp:` (legacy, ignored) or MCP tool names to an agent's `tools:`.

## Adding a server

Prefer asking the user to add it in **Settings → MCP** — that validates the
entry, starts the server, handles OAuth, and shows its status and tools.

To hand-edit, change `<CONFIG_DIR>/mcp.json`. Entries live under `servers`;
names match `^[a-zA-Z][a-zA-Z0-9_-]*$`.

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path"],
      "env": {},
      "enabled": true
    },
    "docs": { "url": "https://example.com/mcp", "headers": {} }
  }
}
```

- **stdio**: `command` (required), `args`, `env`, `enabled` (default `true`).
- **http**: `url` (required), `headers`, `oauth`, `enabled`. An entry with only
  `url` is http; set `"transport"` explicitly when in doubt.
- Unknown keys are rejected — the whole file then fails to load.
- Never put tokens into `env` or `headers` without the user's explicit consent.

## When changes take effect

| Change | Takes effect |
|--------|-------------|
| Added / edited in Settings → MCP | Immediately; tools appear on the next turn. |
| Hand edit of `mcp.json` | After OpenAgentd restarts — tell the user. |
| Server disabled or removed | Its tools disappear on the next turn after it stops. |

Don't try to check server status with `curl`: the API may require an access
key the agent does not have. Ask the user to look at Settings → MCP.
