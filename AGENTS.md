# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

robin-mcp is a personal MCP (Model Context Protocol) server that acts as a knowledge base, API gateway, and writings hub. It exposes tools and resources for notes, bookmarks, GitHub search, Linear project management, and a private creative writing vault.

## Build and Run Commands

```bash
# Build TypeScript to dist/
npm run build

# Development (hot reload with tsx)
npm run dev:stdio    # stdio transport
npm run dev:http     # HTTP transport on port 3001

# Production
npm run start:stdio  # stdio transport
npm run start:http   # HTTP transport

# Test with MCP inspector
npm run inspect
```

There is no test suite or linter configured.

## Architecture

### Entry Points
- `src/stdio.ts` - MCP stdio transport (for Claude Desktop, etc.)
- `src/http.ts` - HTTP transport with session management for web/remote access

Both entry points use `createServer()` from `src/server.ts` which registers all tools and resources.

### Core Modules
- `src/config.ts` - Environment config (loads from `.env`)
- `src/db.ts` - SQLite setup with better-sqlite3, schema init, and seeding default sources

### Tools (`src/tools/`)
Each file exports a `register*Tools(server)` function:
- `notes.ts` - CRUD for notes with FTS5 full-text search
- `bookmarks.ts` - URL bookmarks with tags
- `api-gateway.ts` - GitHub repo search, generic HTTP fetch
- `vault.ts` - Read files from a private GitHub repo (creative vault)
- `linear.ts` - Linear API integration (issues, teams)
- `sources.ts` - Source routing system for prioritizing tools by context

### Resources (`src/resources/`)
- `writings.ts` - Website content, RSS feed, LinkedIn profile
- `knowledge-base.ts` - Tags listing, KB statistics

### Conditional Registration
Tools/resources are registered conditionally based on config:
- `vault.ts` requires `VAULT_REPO` and `GITHUB_TOKEN`
- `linear.ts` requires `LINEAR_API_KEY`  
- `github-search-repos` requires `GITHUB_TOKEN`

## Database

SQLite database at `DB_PATH` (default: `./data/robin.db`). Schema in `db.ts`:
- `notes` - with FTS5 virtual table `notes_fts` and sync triggers
- `bookmarks` - unique URLs
- `sources` / `source_rules` - routing configuration

Database is created automatically on first run with default sources seeded.

## Important Conventions

**stdio transport**: Never use `console.log()` or write to stdout - it corrupts the MCP protocol. Use `console.error()` for all logging.

**Tool registration pattern**: Each tool module exports a single `register*Tools(server: McpServer)` function that calls `server.tool()` for each tool.

**Resource URIs**: Use `robin://` scheme (e.g., `robin://kb/tags`, `robin://vault/structure`).

**Zod schemas**: All tool inputs are validated with Zod. Use `.describe()` for LLM-friendly parameter descriptions.
