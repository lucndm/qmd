# Project Roadmap

## Current Status

**Version:** 2.5.2 | **Status:** Active Development

QMD is a mature on-device hybrid search engine with a stable API surface. Core search pipeline (BM25 + vector + RRF + reranking) is production-ready.

## Completed Milestones

### v2.5.x — MCP Tools & Embed Management
- [x] MCP `update` and `embed` tools for index management
- [x] `QMD_LLM_BACKEND=api` for embed/query CLI commands
- [x] OpenAI-compatible API backend via LiteLLM proxy

### v2.4.x — AST-Aware Chunking
- [x] Tree-sitter integration for code file chunking
- [x] Support for .ts, .js, .py, .go, .rs files
- [x] `--chunk-strategy auto` flag

### v2.3.x — SDK & Library Mode
- [x] `createStore()` public API
- [x] Full type exports for SDK consumers
- [x] Inline config, YAML config, and DB-only modes

### v2.2.x — HTTP MCP Server
- [x] Streamable HTTP transport for MCP
- [x] Background daemon mode (`--daemon`)
- [x] Health endpoint (`GET /health`)

### v2.1.x — Context System
- [x] Hierarchical path-based context
- [x] `qmd://` virtual path scheme
- [x] Global context support

### v2.0.x — Hybrid Search Pipeline
- [x] Reciprocal Rank Fusion (RRF)
- [x] LLM query expansion with fine-tuned model
- [x] Position-aware reranker blending
- [x] Top-rank bonus for original query matches

### v1.x — Foundation
- [x] SQLite FTS5 full-text search
- [x] sqlite-vec vector similarity
- [x] CLI with all core commands
- [x] Collection management
- [x] Smart markdown chunking

## Near-Term Priorities

### Performance & Reliability
- [ ] Reduce cold-start time for LLM model loading
- [ ] Incremental embedding (only re-embed changed chunks)
- [ ] Database migration tooling for schema changes
- [ ] Improve error messages for missing model files

### Search Quality
- [ ] Configurable reranker weights per collection
- [ ] Support for custom embedding models via config
- [ ] Query result caching for repeated searches
- [ ] Boost/penalize signals based on file metadata (age, path)

### Developer Experience
- [ ] `qmd doctor` command for diagnosing setup issues
- [ ] Watch mode for automatic re-indexing on file changes
- [ ] Progress bars for long-running operations
- [ ] Shell completion (bash, zsh, fish)

## Medium-Term Goals

### Multi-Modal Search
- [ ] Image embedding support (CLIP or similar)
- [ ] PDF extraction as first-class format
- [ ] Audio transcript indexing

### Collaboration
- [ ] Shared index via network (read replicas)
- [ ] Index synchronization between devices
- [ ] Team-scoped collections

### Advanced Retrieval
- [ ] Hybrid search with metadata filters (date, author, tags)
- [ ] Faceted search results
- [ ] Search result grouping by topic/cluster
- [ ] Feedback loop (user clicks improve ranking)

## Long-Term Vision

- **Universal local search** — Any document type, any language, fully on-device
- **Agent-native** — First-class integration with AI agent frameworks
- **Plugin system** — Custom retrievers, rerankers, and processors
- **Web UI** — Optional browser-based search interface

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup and contribution guidelines.

## Changelog

Full changelog available in [CHANGELOG.md](../CHANGELOG.md).
