# Codebase Summary

## Project Stats

| Metric | Value |
|--------|-------|
| Total Source LOC | ~15,950 |
| Source Files | 18 |
| Test Files | 30 |
| Language | TypeScript (ESNext, strict) |
| Package Manager | pnpm 10.12.1 |
| Node Version | >= 22 |

## Directory Structure

```
qmd/
├── src/                    # Source code (~15,950 LOC)
│   ├── index.ts            # SDK entry point, createStore(), type re-exports
│   ├── store.ts            # Core store: DB ops, search, indexing, chunking
│   ├── llm.ts              # LlamaCpp wrapper: embed, rerank, query expansion
│   ├── llm-openai.ts       # OpenAI-compatible API backend (LiteLLM proxy)
│   ├── db.ts               # Cross-runtime SQLite compatibility layer
│   ├── collections.ts      # YAML config loading, collection/context management
│   ├── ast.ts              # Tree-sitter AST-aware chunking for code files
│   ├── maintenance.ts      # Database vacuum, cleanup operations
│   ├── paths.ts            # qmdHomedir() helper
│   ├── test-preload.ts     # Bun test preload
│   ├── cli/
│   │   ├── qmd.ts          # CLI entry (commander-based, all commands)
│   │   └── formatter.ts    # Output formatting (TTY, JSON, CSV, MD, XML)
│   ├── mcp/
│   │   └── server.ts       # MCP server (stdio + HTTP transport)
│   ├── bench/              # Benchmarking tools
│   │   ├── bench.ts
│   │   ├── score.ts
│   │   └── types.ts
│   └── types/
│       └── picomatch.d.ts  # Type declarations
├── test/                   # Test suite (Vitest + Bun)
├── scripts/                # Build, release, test scripts
├── skills/                 # Claude Code skills (qmd, release)
├── bin/                    # Shell wrapper for CLI
├── finetune/               # Model fine-tuning data/scripts
├── docs/                   # Project documentation
├── assets/                 # Images (architecture diagram)
└── .github/workflows/      # CI/CD
```

## Module Details

### `store.ts` (5,176 LOC) — Core Engine

The heart of QMD. Contains all database operations, search functions, indexing, and chunking logic.

**Key exports:**
- `createStore(dbPath)` — Opens/creates SQLite database
- `hybridQuery()` — Full hybrid search pipeline (expand + BM25 + vector + RRF + rerank)
- `structuredSearch()` — Pre-expanded query search
- `reindexCollection()` — Scan filesystem and update index
- `generateEmbeddings()` — Generate vector embeddings for unembedded chunks
- `extractSnippet()` — Extract relevant text snippet around match

**Internal components:**
- FTS5 index management (BM25 search)
- sqlite-vec integration (vector search)
- Smart chunking algorithm (markdown-boundary-aware)
- Score normalization and RRF fusion
- LLM cache management
- Document lifecycle (active/inactive tracking)

### `llm.ts` (2,033 LOC) — LLM Integration

Wraps node-llama-cpp for local GGUF model inference.

**Key exports:**
- `LlamaCpp` class — Manages embedding, reranking, and query expansion models
- `formatQueryForEmbedding()` / `formatDocForEmbedding()` — Model-specific prompt formatting
- `withLLMSessionForLlm()` — Session management with auto-dispose

**Model lifecycle:**
- Lazy loading (models loaded on first use)
- Auto-dispose after 5 minutes of inactivity
- Transparent recreation on next request (~1s penalty)
- Models stay loaded in VRAM across requests (HTTP mode)

### `index.ts` (578 LOC) — SDK Entry Point

Public API surface for library consumers.

**Key exports:**
- `createStore(options)` — Returns `QMDStore` interface
- All types: `SearchOptions`, `HybridQueryResult`, `DocumentResult`, etc.
- Utilities: `extractSnippet`, `addLineNumbers`, `Maintenance`

**LLM backend resolution:**
- `QMD_LLM_BACKEND=local` (default) — Uses LlamaCpp with GGUF models
- `QMD_LLM_BACKEND=api` — Uses OpenAI-compatible API via LiteLLM proxy

### `db.ts` (103 LOC) — Database Abstraction

Cross-runtime SQLite compatibility layer.

**Runtime detection:**
- Bun: Uses `bun:sqlite` with `setCustomSQLite()` for Homebrew SQLite on macOS
- Node.js: Uses `better-sqlite3`

**Extension loading:**
- Loads `sqlite-vec` for vector similarity search
- Graceful fallback if extension unavailable (BM25 still works)

### `collections.ts` (542 LOC) — Configuration

YAML-based collection configuration with context management.

**Key features:**
- Load/save `qmd.yml` config files
- Collection CRUD (add, remove, rename)
- Hierarchical context system (`qmd://collection/path`)
- Global context support
- Write-through to YAML when config source is a file

### `ast.ts` (403 LOC) — AST Chunking

Tree-sitter-based code-aware chunking.

**Supported languages:**
- TypeScript / JavaScript (.ts, .tsx, .js, .jsx)
- Python (.py)
- Go (.go)
- Rust (.rs)

**Break point scoring:**
- Class/interface/struct: 100
- Function/method: 90
- Type alias/enum: 80
- Import/use: 60

### `cli/qmd.ts` (4,519 LOC) — CLI Interface

Commander-based CLI with all user-facing commands.

**Commands:**
- `collection add/remove/rename/list` — Collection management
- `context add/list/rm/check` — Context management
- `search` — BM25 full-text search
- `vsearch` — Vector similarity search
- `query` — Hybrid search with reranking
- `get` / `multi-get` — Document retrieval
- `embed` — Generate vector embeddings
- `update` — Re-index collections
- `status` — Index health info
- `mcp` — Start MCP server
- `ls` — List files in collection

### `cli/formatter.ts` (434 LOC) — Output Formatting

Handles all output rendering with TTY detection.

**Features:**
- TTY: Color-coded scores, clickable terminal hyperlinks (OSC 8)
- Non-TTY: Plain text, no escape sequences
- Formats: default (colorized), JSON, CSV, Markdown, XML, files-only
- Editor URI templates (VS Code, Cursor, Zed, Sublime)

### `mcp/server.ts` (947 LOC) — MCP Server

Model Context Protocol server for AI integration.

**Tools exposed:**
- `query` — Typed sub-queries (lex/vec/hyde) with RRF + reranking
- `get` — Retrieve document by path or docid
- `multi_get` — Batch retrieve by glob/comma-separated list
- `status` — Index health and collection info
- `update` — Re-index collections
- `embed` — Generate embeddings

**Transport modes:**
- stdio: Launched as subprocess by each client
- HTTP: Shared server at `http://localhost:8181/mcp`

## Dependency Map

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @modelcontextprotocol/sdk | 1.29.0 | MCP server implementation |
| better-sqlite3 | 12.10.0 | SQLite driver (Node.js) |
| fast-glob | 3.3.3 | Filesystem glob matching |
| node-llama-cpp | 3.18.1 | GGUF model inference |
| picomatch | 4.0.4 | Glob pattern matching |
| sqlite-vec | 0.1.9 | Vector similarity extension |
| tree-sitter-go | 0.25.0 | Go AST parsing |
| tree-sitter-python | 0.25.0 | Python AST parsing |
| tree-sitter-rust | 0.24.0 | Rust AST parsing |
| tree-sitter-typescript | 0.23.2 | TypeScript AST parsing |
| web-tree-sitter | 0.26.8 | Tree-sitter runtime |
| yaml | 2.9.0 | YAML config parsing |
| zod | 4.2.1 | Schema validation |

### Optional Dependencies

| Package | Purpose |
|---------|---------|
| sqlite-vec-darwin-arm64 | sqlite-vec for macOS Apple Silicon |
| sqlite-vec-darwin-x64 | sqlite-vec for macOS Intel |
| sqlite-vec-linux-arm64 | sqlite-vec for Linux ARM |
| sqlite-vec-linux-x64 | sqlite-vec for Linux x86 |
| sqlite-vec-windows-x64 | sqlite-vec for Windows |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @types/better-sqlite3 | 7.6.13 | Type definitions |
| tsx | 4.21.0 | TypeScript execution |
| vitest | 3.2.4 | Test runner |
