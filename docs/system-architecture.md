# System Architecture

## Overview

QMD is a hybrid search engine that combines three retrieval signals — BM25 keyword matching, vector semantic similarity, and LLM re-ranking — into a single query pipeline. All computation runs locally using GGUF models via node-llama-cpp.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Interfaces                        │
├──────────┬──────────────────────┬───────────────────────────┤
│   CLI    │     SDK (Library)    │     MCP Server            │
│ qmd.ts   │     index.ts         │     server.ts             │
│          │     createStore()    │   (stdio / HTTP)          │
└────┬─────┴──────────┬───────────┴──────────┬────────────────┘
     │                │                      │
     └────────────────┼──────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    QMDStore (store.ts)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Search   │ │ Indexing │ │ Document │ │  Collection  │   │
│  │ Pipeline │ │ Engine   │ │ Store    │ │  Management  │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
└───────┼────────────┼────────────┼───────────────┼───────────┘
        │            │            │               │
        ▼            ▼            ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                    SQLite Database                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │   FTS5   │ │ sqlite-  │ │documents │ │ store_       │   │
│  │  Index   │ │   vec    │ │  chunks  │ │ collections  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                   LLM Layer                                 │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │  LlamaCpp (local)│  │  OpenAILLM (API via LiteLLM)    │ │
│  │  - embeddinggemma│  │  - OpenAI-compatible endpoints   │ │
│  │  - qwen3-reranker│  │  - Configurable base URL         │ │
│  │  - query-expander│  │  - API key auth                  │ │
│  └──────────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Search Pipeline

### Hybrid Query Flow

```
User Query
    │
    ▼
┌─────────────────────┐
│  Query Expansion     │  LLM generates 2 alternative queries
│  (query-expansion    │  Original query gets ×2 weight
│   1.7B model)        │
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│              Parallel Retrieval                           │
│  ┌─────────────────┐        ┌─────────────────┐         │
│  │   BM25 (FTS5)   │        │  Vector Search  │         │
│  │   SQLite FTS5   │        │  sqlite-vec     │         │
│  │   Porter stem   │        │  Cosine sim     │         │
│  └────────┬────────┘        └────────┬────────┘         │
│           │                          │                   │
│           └──────────┬───────────────┘                   │
│                      ▼                                   │
│  ┌───────────────────────────────────────────────────┐   │
│  │          Reciprocal Rank Fusion (RRF)             │   │
│  │  score = Σ(1/(k+rank+1))  where k=60             │   │
│  │  - Original query: ×2 weight                      │   │
│  │  - Top-rank bonus: +0.05 for #1, +0.02 for #2-3  │   │
│  │  - Top 30 candidates kept                         │   │
│  └──────────────────────┬────────────────────────────┘   │
└─────────────────────────┼────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│              LLM Re-ranking                              │
│  ┌───────────────────────────────────────────────────┐   │
│  │  qwen3-reranker-0.6B                              │   │
│  │  - Cross-encoder: scores query-document pairs     │   │
│  │  - Returns yes/no + logprob confidence            │   │
│  │  - Score range: 0.0 - 1.0                         │   │
│  └──────────────────────┬────────────────────────────┘   │
│                         │                                 │
│                         ▼                                 │
│  ┌───────────────────────────────────────────────────┐   │
│  │  Position-Aware Blending                          │   │
│  │  - Rank 1-3:  75% RRF / 25% reranker             │   │
│  │  - Rank 4-10: 60% RRF / 40% reranker             │   │
│  │  - Rank 11+:  40% RRF / 60% reranker             │   │
│  └──────────────────────┬────────────────────────────┘   │
└─────────────────────────┼────────────────────────────────┘
                          │
                          ▼
                    Final Results
```

### Score Normalization

| Backend | Raw Score | Conversion | Range |
|---------|-----------|------------|-------|
| FTS (BM25) | SQLite FTS5 BM25 | `Math.abs(score)` | 0 to ~25+ |
| Vector | Cosine distance | `1 / (1 + distance)` | 0.0 to 1.0 |
| Reranker | LLM 0-10 rating | `score / 10` | 0.0 to 1.0 |

## Data Storage

### SQLite Schema

```sql
-- Collections: indexed directories
CREATE TABLE store_collections (
  name TEXT PRIMARY KEY,
  pwd TEXT NOT NULL,
  glob_pattern TEXT,
  ignore_patterns TEXT,
  include_by_default INTEGER DEFAULT 1,
  last_modified TEXT
);

-- Path-based context metadata
CREATE TABLE path_contexts (
  collection TEXT NOT NULL,
  path_prefix TEXT NOT NULL,
  context TEXT NOT NULL,
  PRIMARY KEY (collection, path_prefix)
);

-- Documents: indexed markdown files
CREATE TABLE documents (
  hash TEXT PRIMARY KEY,       -- SHA-256 content hash
  path TEXT NOT NULL,
  collection TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  docid TEXT NOT NULL,         -- First 6 chars of hash
  is_active INTEGER DEFAULT 1,
  last_modified TEXT
);

-- FTS5 full-text index
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content,
  content=documents,
  content_rowid=rowid
);

-- Embedding chunks
CREATE TABLE content_vectors (
  hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  content TEXT NOT NULL,
  title TEXT,
  PRIMARY KEY (hash, seq)
);

-- Vector index (sqlite-vec)
CREATE VIRTUAL TABLE vectors_vec USING vec0(
  hash_seq TEXT PRIMARY KEY,
  embedding FLOAT[384]         -- Dimension depends on model
);

-- LLM response cache
CREATE TABLE llm_cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Index Storage

```
~/.cache/qmd/
├── index.sqlite              # Main database
└── models/                   # Downloaded GGUF models
    ├── embeddinggemma-300M-Q8_0.gguf
    ├── qwen3-reranker-0.6b-q8_0.gguf
    └── qmd-query-expansion-1.7B-q4_k_m.gguf
```

## Smart Chunking

Documents are split into ~900-token chunks with 15% overlap. The algorithm prefers natural markdown boundaries:

```
Document
    │
    ▼
┌─────────────────────────────────────────────┐
│  Scan for break points                      │
│  - # Heading (100)                          │
│  - ## Heading (90)                          │
│  - ### Heading (80)                         │
│  - ``` code fence (80)                      │
│  - --- horizontal rule (60)                 │
│  - Blank line (20)                          │
│  - List item (5)                            │
│  - Line break (1)                           │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Find optimal cut point                     │
│  Window: 200 tokens before target           │
│  Score = base × (1 - (dist/window)² × 0.7) │
│  Cut at highest-scoring break point         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Code fence protection                      │
│  Break points inside ``` blocks are ignored │
│  Large code blocks kept whole               │
└─────────────────────────────────────────────┘
```

### AST-Aware Chunking (Code Files)

For `.ts`, `.js`, `.py`, `.go`, `.rs` files, tree-sitter adds AST-derived break points:

| AST Node | Score |
|----------|-------|
| Class / interface / struct / impl / trait | 100 |
| Function / method | 90 |
| Type alias / enum | 80 |
| Import / use declaration | 60 |

Enable with `--chunk-strategy auto`. Falls back to regex if tree-sitter grammars unavailable.

## Cross-Runtime Compatibility

```
┌─────────────────────────────────────────────────┐
│                 db.ts                            │
│  ┌─────────────────┐  ┌─────────────────────┐   │
│  │   Bun Runtime   │  │   Node.js Runtime   │   │
│  │   bun:sqlite    │  │   better-sqlite3    │   │
│  │                 │  │                     │   │
│  │  setCustomSQL() │  │  Native extension   │   │
│  │  for Homebrew   │  │  loading            │   │
│  │  SQLite on macOS│  │                     │   │
│  └────────┬────────┘  └──────────┬──────────┘   │
│           │                      │               │
│           └──────────┬───────────┘               │
│                      ▼                           │
│            Common Database Interface             │
│            exec, prepare, transaction,           │
│            loadExtension, close                  │
└─────────────────────────────────────────────────┘
```

## MCP Server Architecture

```
┌─────────────────────────────────────────────────┐
│              MCP Server (server.ts)              │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐   │
│  │   Stdio      │    │   HTTP Transport      │   │
│  │  Transport   │    │   POST /mcp           │   │
│  │  (subprocess)│    │   GET /health         │   │
│  └──────┬───────┘    └───────────┬───────────┘   │
│         │                        │               │
│         └──────────┬─────────────┘               │
│                    ▼                             │
│  ┌──────────────────────────────────────────┐    │
│  │         MCP Tool Handlers                │    │
│  │  - query (lex/vec/hyde sub-queries)      │    │
│  │  - get (by path or docid)                │    │
│  │  - multi_get (batch retrieval)           │    │
│  │  - status (index health)                 │    │
│  │  - update (re-index)                     │    │
│  │  - embed (generate vectors)              │    │
│  └──────────────────────────────────────────┘    │
│                    │                             │
│                    ▼                             │
│            QMDStore instance                    │
└─────────────────────────────────────────────────┘
```

## LLM Backend Architecture

```
┌─────────────────────────────────────────────────┐
│           LLM Interface (llm.ts)                │
│                                                  │
│  ┌─────────────────┐  ┌─────────────────────┐   │
│  │  LlamaCpp       │  │  OpenAILLM          │   │
│  │  (local GGUF)   │  │  (API via LiteLLM)  │   │
│  │                 │  │                     │   │
│  │  Models:        │  │  - embed endpoint   │   │
│  │  - embedding    │  │  - generate endpoint│   │
│  │  - reranker     │  │  - rerank endpoint  │   │
│  │  - query expand │  │  - API key auth     │   │
│  │                 │  │                     │   │
│  │  Lifecycle:     │  │  Config:            │   │
│  │  - Lazy load    │  │  QMD_LLM_BACKEND=api│   │
│  │  - Auto-dispose │  │  QMD_API_BASE_URL   │   │
│  │  - 5min timeout │  │  QMD_API_KEY        │   │
│  └─────────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Request Flow: CLI `query` Command

```
1. User runs: qmd query "authentication flow"
2. CLI parses args → calls store.search({ query })
3. store.search → hybridQuery()
4. hybridQuery:
   a. expandQuery() → LLM generates 2 variants
   b. searchFTS() for each query (3 total)
   c. searchVec() for each query (3 total)
   d. RRF fusion → top 30 candidates
   e. rerank() → LLM scores each candidate
   f. Position-aware blend → final ranking
5. Results returned to CLI
6. Formatter renders (TTY colors or plain text)
```
