# robin-mcp

A personal [Model Context Protocol](https://modelcontextprotocol.io) server that acts as a knowledge base, API gateway, and hub for personal writings. Built with TypeScript, Express, and SQLite.

## What it does

robin-mcp aggregates personal data sources into a single MCP server, so AI assistants like Claude and ChatGPT can search, read, and manage information across multiple services through one interface.

### Tools

**Notes & Bookmarks (SQLite with FTS5 full-text search)**
- Create, search, read, update, and delete notes with tags
- Save, search, and manage bookmarks

**Linear**
- Search issues, view issue details and comments
- List assigned issues with team/status filters
- Create new issues

**GitHub**
- Search repositories
- Read files and browse directories in a private Creative Vault repo

**Source Routing**
- Context-aware routing system that recommends which tools and sources to prioritize for different types of tasks (code, creative writing, project management, etc.)

**General**
- HTTP fetch for any public URL or API

### Resources

- Personal website content and blog posts (via RSS)
- Website subsections: Shiny Toy Robots, Alternate Frequencies, Static Drift
- Linear teams overview
- Knowledge base tags and statistics
- Source routing guide
- Creative Vault file tree

## Architecture

- **Dual transport**: stdio for local use (Claude Code, Claude Desktop), Streamable HTTP for remote access (ChatGPT, remote Claude)
- **SQLite** with WAL mode and FTS5 full-text search via `better-sqlite3`
- **Express 5** for the HTTP entry point with session management
- **Contextual source routing** with SQLite-backed rules and seed data
- **Read-only access mode** for shared tokens (write tools excluded)
- **Cloudflare Access** integration for browser-based authentication

## Deployment

Runs locally via stdio or deployed remotely on Railway with a persistent volume for SQLite. Cloudflare Access provides an optional OAuth layer for browser-based authentication.

## Stack

TypeScript, Node.js (ESM), Express 5, SQLite (better-sqlite3), Zod, MCP SDK
