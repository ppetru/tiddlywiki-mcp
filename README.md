# TiddlyWiki MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with access to TiddlyWiki wikis via the HTTP API. Supports semantic search using Ollama embeddings.

## Features

### MCP Tools

- **search_tiddlers** - Search tiddlers using TiddlyWiki filter syntax, semantic similarity, or hybrid (both combined)
- **create_tiddler** - Create new tiddlers with custom fields
- **update_tiddler** - Update existing tiddlers with diff preview
- **delete_tiddler** - Delete tiddlers with content preview

### MCP Resources

- **filter-reference://syntax** - Complete TiddlyWiki filter syntax reference

### Semantic Search

When Ollama is available, the server provides semantic search capabilities:

- Natural language queries find conceptually related tiddlers
- Uses `nomic-embed-text` embeddings model
- SQLite-vec for efficient vector similarity search
- Background sync keeps embeddings up-to-date
- Hybrid mode combines filter results with semantic reranking

## Requirements

- Node.js 22+
- TiddlyWiki with HTTP API enabled (e.g., TiddlyWiki on Node.js with `listen` command)
- Ollama (optional, for semantic search)

### Build Prerequisites

This project uses native SQLite modules that require compilation. You'll need:

- **Linux**: `build-essential`, Python 3
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Visual Studio Build Tools, Python 3

## Installation

### From npm (recommended)

```bash
TIDDLYWIKI_URL=http://localhost:8080 npx tiddlywiki-mcp-server
```

Or install globally:

```bash
npm install -g tiddlywiki-mcp-server
TIDDLYWIKI_URL=http://localhost:8080 tiddlywiki-mcp-server
```

### From source

```bash
git clone https://github.com/ppetru/tiddlywiki-mcp.git
cd tiddlywiki-mcp
npm install
npm run build
```

## Quick Start

### 1. Start TiddlyWiki with HTTP API

```bash
# Install TiddlyWiki if you haven't already
npm install -g tiddlywiki

# Create a new wiki and start it with HTTP API
tiddlywiki mywiki --init server
tiddlywiki mywiki --listen port=8080
```

### 2. (Optional) Set up Ollama for Semantic Search

```bash
# Install Ollama from https://ollama.ai
# Then pull the embedding model:
ollama pull nomic-embed-text
```

### 3. Start the MCP Server

```bash
TIDDLYWIKI_URL=http://localhost:8080 npx tiddlywiki-mcp-server
```

## Configuration

All configuration is via environment variables. See `.env.example` for a complete reference.

### Required

| Variable | Description |
|----------|-------------|
| `TIDDLYWIKI_URL` | URL of your TiddlyWiki server (e.g., `http://localhost:8080`) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3000` | HTTP server port (when using http transport) |
| `MCP_HOST` | `127.0.0.1` | HTTP server interface. Set `0.0.0.0` to accept connections from other machines or containers. See [Deployment](#deployment) |
| `MCP_AUTH_TOKEN` | none | Require `Authorization: Bearer <token>` on `/mcp` (at least 32 characters) |
| `MCP_ALLOWED_HOSTS` | localhost names on loopback, any otherwise | Comma-separated hostnames accepted in the `Host` header, e.g. for a reverse proxy on the same machine |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model name |
| `EMBEDDINGS_ENABLED` | `true` | Enable/disable semantic search |
| `EMBEDDINGS_DB_PATH` | `./embeddings.db` | SQLite database path for embeddings |
| `AUTH_HEADER` | `X-Oidc-Username` | HTTP header for authentication (can be any header your TiddlyWiki expects) |
| `AUTH_USER` | `mcp-user` | Username for TiddlyWiki API requests |

## Usage

### stdio Mode (Claude Desktop)

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tiddlywiki": {
      "command": "npx",
      "args": ["tiddlywiki-mcp-server"],
      "env": {
        "TIDDLYWIKI_URL": "http://localhost:8080"
      }
    }
  }
}
```

### HTTP Mode

Start the server:

```bash
TIDDLYWIKI_URL=http://localhost:8080 MCP_TRANSPORT=http MCP_PORT=3000 npx tiddlywiki-mcp-server
```

The server exposes:
- `GET /health` - Health check endpoint (never requires a token)
- `POST /mcp` - MCP JSON-RPC endpoint (stateless mode)

By default the server only listens on `127.0.0.1` and rejects requests whose `Host` header is not a localhost name, which protects it against DNS rebinding from websites in a local browser. The same applies to any `MCP_HOST` that resolves only to loopback addresses (`127.0.0.0/8`, `::1`). With `MCP_HOST=localhost`, Node.js may listen on `::1` only, so prefer `127.0.0.1`.

Browser requests to `/mcp` are also checked by their `Origin` header, as the MCP spec requires. An origin is accepted if its hostname is an allowed `Host` name (e.g. a local dev tool on `http://localhost:6274`), or, when any `Host` is allowed, if it is the server's own origin. Clients that send no `Origin` (non-browser clients) are not affected.

`MCP_HOST`, `MCP_AUTH_TOKEN` and `MCP_ALLOWED_HOSTS` must not be set to an empty value. The server refuses to start, because an empty secret from a template or vault lookup would otherwise switch auth off silently.

### Deployment

To reach the server from other machines, containers or an orchestrator (Docker, Nomad), set `MCP_HOST=0.0.0.0` and protect it with a token:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
TIDDLYWIKI_URL=http://localhost:8080 MCP_TRANSPORT=http MCP_HOST=0.0.0.0 npx tiddlywiki-mcp-server
```

Clients then send `Authorization: Bearer <token>` with every request to `/mcp`. Use HTTPS (e.g. a reverse proxy) when the token crosses a network you don't control. A 401 response carries `WWW-Authenticate: Bearer`. Some MCP clients take that as a cue to try OAuth discovery, so a mistyped token can show up as an OAuth error in the client.

**Behind an authenticating proxy** (e.g. OIDC): the token is optional, since the proxy decides who gets through. Without a token, the server logs a warning when it listens beyond localhost, as a reminder that the port itself must not be reachable around the proxy. If the proxy forwards its own `Authorization` header, don't set `MCP_AUTH_TOKEN`, because the two would clash.

**Reverse proxy or sidecar on the same machine** (e.g. Caddy, nginx, a Consul Connect/Envoy sidecar): keep `MCP_HOST=127.0.0.1` and list the hostnames the proxy forwards in the `Host` header, e.g. `MCP_ALLOWED_HOSTS=wiki.example.com`. Otherwise these requests are rejected with 403 by the DNS rebinding protection. `MCP_ALLOWED_HOSTS` replaces the default list, so add `localhost` if you also connect locally. Entries are hostnames without a port; write IPv6 addresses in brackets.

**Containers without a token** (e.g. Docker with `-p 3000:3000` on a laptop): with `MCP_HOST=0.0.0.0`, set `MCP_ALLOWED_HOSTS` as well. Otherwise a website in a local browser can reach the server through DNS rebinding.

### Upgrading to 2.0

The HTTP server used to listen on all interfaces and now defaults to `127.0.0.1`. If you run it in a container, on Nomad, or reach it from another machine, set `MCP_HOST=0.0.0.0`, preferably together with `MCP_AUTH_TOKEN`. Otherwise port mappings and health checks can't reach the server. Behind a sidecar on the same host, keep `127.0.0.1` and set `MCP_ALLOWED_HOSTS` instead (see above).

Browser-based clients from other origins are now rejected (see `Origin` above).

### Example Tool Usage

**Filter search** (TiddlyWiki filter syntax):
```json
{
  "name": "search_tiddlers",
  "arguments": {
    "filter": "[tag[Journal]prefix[2025-01]]",
    "includeText": true
  }
}
```

**Semantic search** (natural language):
```json
{
  "name": "search_tiddlers",
  "arguments": {
    "semantic": "times I felt anxious about work",
    "limit": 10
  }
}
```

**Hybrid search** (filter + semantic reranking):
```json
{
  "name": "search_tiddlers",
  "arguments": {
    "filter": "[tag[Journal]]",
    "semantic": "productivity tips",
    "limit": 20
  }
}
```

## Development

### Setup

```bash
npm install
```

### Running Tests

```bash
npm test
```

Tests run quickly (~1s) and include unit tests for all tool handlers.

### Linting

```bash
npm run lint        # Check for issues
npm run format      # Fix formatting
npm run format:check # Check formatting only
```

### Type Checking

```bash
npm run typecheck
```

### Pre-commit Hooks

Pre-commit hooks are configured with lefthook and run automatically:

1. Format check (Prettier)
2. Lint (ESLint)
3. Tests (Vitest)
4. Type check (TypeScript)

### Building

```bash
npm run build
```

## Architecture

```
src/
├── index.ts              # Entry point, transport setup, server lifecycle
├── tiddlywiki-http.ts    # TiddlyWiki HTTP API client
├── service-discovery.ts  # URL resolution (direct URLs, Consul SRV, hostname:port)
├── filter-reference.ts   # Filter syntax documentation
├── logger.ts             # Structured logging
├── tools/                # MCP tool handlers
│   ├── types.ts          # Shared types and Zod schemas
│   ├── search-tiddlers.ts
│   ├── create-tiddler.ts
│   ├── update-tiddler.ts
│   └── delete-tiddler.ts
└── embeddings/           # Semantic search infrastructure
    ├── database.ts       # SQLite-vec database
    ├── ollama-client.ts  # Ollama API client
    └── sync-worker.ts    # Background embedding sync
```

### Key Design Decisions

- **Stateless HTTP mode**: Each request gets its own Server/Transport instance to prevent request ID collisions with concurrent clients
- **Graceful degradation**: Semantic search is optional; the server works without Ollama
- **Token-aware responses**: Search results are validated against token limits with pagination suggestions
- **Background sync**: Embeddings are updated periodically without blocking requests

## License

MIT
