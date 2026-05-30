# Project Overview & Product Development Requirements

## Product Summary

**QMD** (Query Markup Documents) is an on-device hybrid search engine for markdown files, documentation, meeting transcripts, and knowledge bases. It combines BM25 full-text search, vector semantic search, and LLM re-ranking — all running locally via node-llama-cpp with GGUF models.

**Version:** 2.5.2 | **License:** MIT | **Author:** Tobi Lutke

## Problem Statement

Knowledge workers and AI agents need fast, accurate search across local markdown collections without sending data to external services. Existing solutions either require cloud connectivity, lack semantic understanding, or are too slow for interactive use.

## Target Users

| User Type | Use Case |
|-----------|----------|
| Developers | Search code documentation, meeting notes, design docs |
| AI Agents | Retrieve relevant context for RAG pipelines via CLI/SDK/MCP |
| Knowledge Workers | Query personal notes, journals, project documentation |
| Teams | Shared knowledge base via HTTP MCP server |

## Core Value Proposition

- **Fully local** — no data leaves the device, no API keys required for default mode
- **Hybrid search** — combines keyword (BM25), semantic (vector), and LLM re-ranking for best quality
- **Multi-surface** — CLI, SDK (library), and MCP server (stdio + HTTP)
- **Cross-runtime** — works on both Node.js and Bun
- **Agentic-ready** — JSON/file output formats designed for LLM consumption

## Feature Matrix

### Search Capabilities

| Feature | Status | Description |
|---------|--------|-------------|
| BM25 Full-Text Search | Done | SQLite FTS5 with porter stemming |
| Vector Semantic Search | Done | sqlite-vec with embeddinggemma-300M |
| Hybrid Query (RRF) | Done | Reciprocal Rank Fusion combining BM25 + vector |
| LLM Query Expansion | Done | Fine-tuned 1.7B model generates query variants |
| LLM Re-ranking | Done | qwen3-reranker-0.6b with position-aware blending |
| Collection Scoping | Done | Restrict search to specific collections |
| Context-Aware Results | Done | Path-based context metadata returned with results |

### Data Management

| Feature | Status | Description |
|---------|--------|-------------|
| Collection Management | Done | Add, remove, rename collections with glob patterns |
| Context System | Done | Hierarchical context via `qmd://` virtual paths |
| Document ID (docid) | Done | 6-char content hash for stable references |
| Smart Chunking | Done | 900 tokens/chunk, markdown-boundary-aware |
| AST-Aware Chunking | Done | tree-sitter for .ts/.js/.py/.go/.rs files |
| Incremental Indexing | Done | Only re-indexes changed files |
| YAML Config | Done | Collections defined in `qmd.yml` |

### Integration

| Feature | Status | Description |
|---------|--------|-------------|
| CLI Tool | Done | Full-featured command-line interface |
| SDK / Library | Done | `createStore()` API for programmatic use |
| MCP Server (stdio) | Done | Model Context Protocol for Claude/AI integration |
| MCP Server (HTTP) | Done | Shared server with Streamable HTTP transport |
| JSON Output | Done | Structured results for agent consumption |
| Multiple Output Formats | Done | JSON, CSV, Markdown, XML, files-only |
| OpenAI-Compatible API Backend | Done | Use LiteLLM proxy instead of local GGUF models |

### Models

| Model | Purpose | Size | Auto-Download |
|-------|---------|------|---------------|
| embeddinggemma-300M-Q8_0 | Vector embeddings | ~300MB | Yes |
| qwen3-reranker-0.6b-q8_0 | Re-ranking | ~640MB | Yes |
| qmd-query-expansion-1.7B-q4_k_m | Query expansion | ~1.1GB | Yes |

## Success Metrics

| Metric | Target |
|--------|--------|
| Search latency (BM25) | < 50ms |
| Search latency (hybrid + rerank) | < 3s |
| Indexing throughput | > 1000 docs/min |
| Embedding throughput | > 100 chunks/min |
| npm weekly downloads | Growing |
| GitHub issues resolved | > 80% within 2 weeks |

## Non-Goals

- Cloud-hosted search service
- Real-time collaborative editing
- Support for non-markdown formats (PDF, DOCX) as first-class
- GUI/web interface (CLI + SDK + MCP only)
- Multi-user authentication/authorization

## Constraints

- Must work offline (no external API calls in default mode)
- Must support both Node.js >= 22 and Bun >= 1.0.0
- SQLite database must be portable (single file)
- GGUF models auto-downloaded on first use (~2GB total)
- macOS requires Homebrew SQLite for Bun runtime (extension loading)
