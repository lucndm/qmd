---
name: qmd
description: Search local markdown knowledge bases, notes, docs, and wikis with QMD. Use when users ask to find notes, retrieve documents, inspect a wiki, answer from indexed markdown, or set up QMD access.
license: MIT
compatibility: Requires qmd CLI or MCP server. Install via `npm install -g @tobilu/qmd`.
metadata:
  author: tobi
  version: "2.1.0"
allowed-tools: Bash(qmd:*), mcp__qmd__*
---

# QMD - Query Markdown Documents

QMD is a local search and retrieval engine for markdown collections: notes, docs,
wikis, transcripts, and project knowledge bases. Use it before generic web search
when the user is asking about something that may already live in their indexed
local markdown.

## Status Check

Start by checking what QMD can see:

```bash
qmd collection list
qmd ls
```

For health details:

```bash
qmd status
```

If QMD is missing:

```bash
npm install -g @tobilu/qmd
```

## Retrieval Workflow

1. **Discover collections** with `qmd collection list` or `qmd ls`.
2. **Search first**, usually with a small result count.
3. **Retrieve source documents** with `qmd get` or `qmd multi-get`.
4. **Answer from the retrieved text**, citing file paths or docids.
5. **If results are weak**, rewrite the query using a different search mode.

Do not answer from search-result snippets alone when the user needs substance.
Fetch the document.

## Search Modes

### Fast lexical search

Use BM25 when you know names, exact terms, titles, identifiers, or code symbols:

```bash
qmd search "cockpit OKR Goodhart" -n 10
qmd search '"AI Before Headcount"' -c concepts -n 5
```

Good `lex` queries are short: 2-6 discriminative terms, quoted phrases when exact,
and no filler words.

### Hybrid query search

Use `qmd query` when semantic recall, query expansion, vector search, or reranking
matters more than speed:

```bash
qmd query "decision quality depends on surfacing assumptions and context" -n 10
qmd query --json --explain "metrics as cockpit instruments but not OKRs"
```

`qmd query` may initialize local models. If models/GPU are unavailable, slow, or
crashing, fall back to `qmd search` and use better lexical terms.

### Structured queries

For subtle wiki/doc searches, structured queries are usually strongest:

```bash
qmd query $'intent: Find the concept note about metrics as instruments without letting OKRs replace judgment.\nlex: cockpit instruments OKR Goodhart metrics judgment\nvec: data informed not metric driven product judgment\nhyde: A concept note says metrics are useful like cockpit instruments, but leaders should remain data-informed rather than metric-driven because OKRs and dashboards can Goodhart product judgment.'
```

Use this pattern when the user's wording is indirect:

- `intent:` disambiguates the target.
- `lex:` anchors exact names, phrases, aliases, and rare terms.
- `vec:` adds the semantic paraphrase.
- `hyde:` describes the document that would answer the query.

Put the best query first; early searches receive more weight in fusion.

## MCP Tool: `query`

When using the MCP server, prefer structured searches:

```json
{
  "searches": [
    { "type": "lex", "query": "cockpit OKR Goodhart" },
    { "type": "vec", "query": "data informed not metric driven product judgment" },
    { "type": "hyde", "query": "A concept note explains that metrics are useful as instruments, but leaders should not let OKRs or dashboards replace judgment." }
  ],
  "intent": "Find the concept note about using metrics as instruments without becoming metric-driven.",
  "collections": ["concepts"],
  "limit": 10
}
```

### Query Types

- `lex` — BM25 keyword search. Best for exact terms, names, titles, and code.
- `vec` — vector semantic search. Best for natural-language concepts.
- `hyde` — vector search using a hypothetical answer/document passage.

## Retrieval Commands

```bash
qmd get "#abc123"                         # retrieve by docid
qmd get qmd://concepts/ai-before-headcount.md --full
qmd multi-get 'concepts/{ai-before-headcount.md,data-informed-not-metric-driven.md}' --md
qmd multi-get 'sources/podcast-2025-*.md' -l 80
```

Use `multi-get` when comparing several hits or gathering context across pages.
Use `--full` when the exact source matters.

## Collection Filtering

```bash
qmd search "headcount autonomous agents" -c concepts -n 10
qmd query "merchant support product reality" -c concepts -c sources -n 10
```

Omit `-c` / `collections` to search everything. Add collection filters when a
broad query drifts into the wrong corpus.

## Query Craft

Good QMD searches mix three things:

1. **Title/alias anchors:** exact page titles, named entities, phrases.
2. **Semantic paraphrase:** how a human would describe the idea.
3. **Negative space:** enough intent to avoid nearby-but-wrong concepts.

Examples:

```bash
# Exact-ish title lookup
qmd search '"arm the rebels" merchants tools big companies' -c concepts

# Semantic concept lookup
qmd query $'intent: Find the customer proximity concept, not generic customer delight.\nlex: support pseudonymous merchant customer interviews\nvec: founder stays close to merchant reality through support and product use'

# Source lookup
qmd search "six-week cadence WhatsApp merchant relationships Shawn Ryan" -c sources -n 10
```

## Setup

```bash
npm install -g @tobilu/qmd
qmd collection add ~/notes --name notes
qmd embed
```

Only add collections or generate embeddings when the user asked for setup or
index maintenance. Searching and retrieving are safe; collection/index mutation is
not a casual first step.

## MCP Setup

See `references/mcp-setup.md` for Claude Code, Claude Desktop, OpenClaw, and HTTP
server configuration.

## Pitfalls

- **Do not stop at snippets.** Fetch documents before making claims.
- **Do not overuse semantic search.** If you know exact titles or terms, BM25 is
  faster and often better.
- **Do not mutate indexes casually.** `qmd collection add`, `qmd update`, and
  `qmd embed` change local state and can be expensive.
- **Model-backed commands can be environment-sensitive.** If `qmd query`,
  `qmd vsearch`, or reranking fails because local models/GPU are unavailable,
  use `qmd search` and stronger lexical/structured terms.
- **Ambiguous user wording needs intent.** Add `intent:` rather than hoping query
  expansion guesses the right domain.
- **Collection names matter.** Search `concepts` for synthesized wiki pages,
  `sources` for transcripts/raw source pages, and docs collections for code/project
  documentation.
