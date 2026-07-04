# Memento

Local, file-owned memory layer for coding agents, exposed as an MCP server.

## Commands

- `bun install` - Install dependencies
- `bun run build` - Compile TypeScript to `dist/`
- `bun run typecheck` - Type-check without emitting
- `bun run lint` - ESLint
- `bun run format` - Prettier (writes; skips `*.md` per `.prettierignore`)
- `bun run test` - Run the Vitest suite
- `bunx vitest run test/foo.test.ts` - Run a single test file

## Stack

- Language: TypeScript (ESM, `NodeNext`), runtime Node >=20, managed with Bun
- Protocol: MCP via `@modelcontextprotocol/sdk`
- Store: markdown files (YAML front matter) + SQLite FTS5 search index
- Test runner: Vitest

## Structure

- `/src` - Server, tools, and store implementation
- `/test` - Vitest specs and fixtures

## Patterns

- Markdown files are the authoritative store; the SQLite index is derived and must be rebuildable from `memories/*.md`.
