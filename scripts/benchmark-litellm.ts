#!/usr/bin/env bun
/**
 * Benchmark LiteLLM Embedding & Reranking (Comprehensive)
 *
 * Usage:
 *   bun scripts/benchmark-litellm.ts
 *   bun scripts/benchmark-litellm.ts --embed-only
 *   bun scripts/benchmark-litellm.ts --rerank-only
 *   bun scripts/benchmark-litellm.ts --stress
 *
 * Environment:
 *   LITELLM_API_KEY - API key for LiteLLM proxy
 */

import { OpenAILLM } from "../src/llm-openai.js";

// =============================================================================
// Config
// =============================================================================

const LITELLM_BASE_URL = "https://z.minhluc.info/";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "";

const EMBED_MODEL = "qwen3-embedding-small";
const RERANK_MODEL = "qwen3-reranker-small";
const GENERATE_MODEL = "MiniMax-M2.7";

// =============================================================================
// Test Data - Embedding
// =============================================================================

const EMBED_SHORT_TEXTS = [
  "Hello world",
  "Machine learning",
  "Search engine",
  "Vector database",
  "API proxy",
];

const EMBED_MEDIUM_TEXTS = [
  "LightRAG is a graph-based retrieval augmented generation framework that uses knowledge graphs to enhance document retrieval and reasoning capabilities.",
  "Meilisearch is a fast, open-source search engine that provides typo-tolerant full-text search with instant results and easy deployment.",
  "QMD combines BM25 full-text search with vector semantic search and LLM re-ranking to provide high-quality hybrid search results.",
  "LiteLLM is a proxy server that simplifies managing multiple LLM API calls with unified interface, load balancing, and fallback support.",
  "Knowledge graphs represent entities and their relationships as nodes and edges, enabling structured information retrieval and multi-hop reasoning.",
];

const EMBED_LONG_TEXTS = [
  `Retrieval Augmented Generation (RAG) is a technique that enhances large language models by retrieving relevant documents from an external knowledge base before generating responses. Traditional RAG systems use flat document retrieval based on vector similarity, which can miss complex relationships between entities. Graph-based RAG approaches like LightRAG address this limitation by constructing knowledge graphs that capture entity relationships and enabling multi-hop reasoning across connected documents. This approach significantly improves retrieval quality for queries that require understanding relationships between multiple concepts.`,
  `Search engines have evolved from simple keyword matching to sophisticated hybrid systems that combine multiple retrieval signals. Modern search engines like Meilisearch use a combination of BM25 full-text search for keyword matching, vector embeddings for semantic understanding, and machine learning models for re-ranking results. The key challenge is balancing retrieval speed with result quality, especially when dealing with multilingual content and complex queries that require understanding context and intent rather than just matching keywords.`,
  `The Model Context Protocol (MCP) is a standard for connecting AI assistants to external data sources and tools. It allows AI models to access real-time information, execute commands, and interact with various services through a unified interface. MCP servers expose tools and resources that AI assistants can use to enhance their capabilities, such as searching knowledge bases, querying databases, or executing code. This protocol enables building more powerful and context-aware AI applications that can leverage external knowledge and services.`,
];

const EMBED_VIETNAMESE_TEXTS = [
  "LightRAG là một framework retrieval augmented generation dựa trên đồ thị",
  "Meilisearch là công cụ tìm kiếm mã nguồn mở với khả năng tìm kiếm tức thì",
  "QMD kết hợp tìm kiếm BM25 với tìm kiếm ngữ nghĩa vector và tái xếp hạng LLM",
  "LiteLLM là proxy server để quản lý các cuộc gọi API LLM từ nhiều nhà cung cấp",
  "Đồ thị tri thức biểu diễn các thực thể và mối quan hệ giữa chúng dưới dạng nodes và edges",
];

const EMBED_MULTILINGUAL_TEXTS = [
  "LightRAG is a graph-based RAG framework. LightRAG là framework RAG dựa trên đồ thị.",
  "Meilisearch provides instant search. Meilisearch cung cấp tìm kiếm tức thì.",
  "QMD hybrid search combines BM25 and vector. Tìm kiếm lai QMD kết hợp BM25 và vector.",
];

// =============================================================================
// Test Data - Reranking
// =============================================================================

const RERANK_QUERIES = [
  "graph-based RAG framework for knowledge retrieval",
  "how to build a search engine with vector embeddings",
  "MCP server for AI assistants",
  "tìm kiếm ngữ nghĩa với vector database",
  "hybrid search combining BM25 and semantic",
];

const RERANK_DOCS_7 = [
  "LightRAG uses graph structures to enhance retrieval augmented generation with multi-hop reasoning capabilities.",
  "Meilisearch provides typo-tolerant full-text search with instant results and easy deployment.",
  "Traditional RAG systems retrieve documents based on vector similarity without understanding relationships.",
  "QMD hybrid search combines BM25 keyword matching with vector embeddings and LLM reranking.",
  "Knowledge graphs store entities as nodes and relationships as edges for structured information retrieval.",
  "Vector databases store high-dimensional embeddings for similarity search operations.",
  "Graph neural networks can learn representations of graph-structured data for various tasks.",
];

const RERANK_DOCS_15 = [
  ...RERANK_DOCS_7,
  "The Model Context Protocol enables AI assistants to connect to external tools and data sources.",
  "BM25 is a probabilistic retrieval model that ranks documents based on term frequency and inverse document frequency.",
  "Semantic search uses natural language understanding to find conceptually relevant documents.",
  "Chunking strategies split documents into smaller segments for more precise retrieval.",
  "Re-ranking models score retrieved documents using cross-encoder architecture for better relevance.",
  "Query expansion generates alternative query formulations to improve recall.",
  "Hybrid retrieval combines multiple search signals using fusion algorithms like Reciprocal Rank Fusion.",
  "Embedding models convert text into dense vector representations for similarity search.",
];

const RERANK_DOCS_30 = [
  ...RERANK_DOCS_15,
  "SQLite is a lightweight embedded database engine used in mobile and desktop applications.",
  "PostgreSQL is an advanced open-source relational database with extensible architecture.",
  "Redis is an in-memory data store used for caching and real-time applications.",
  "Docker containers package applications with their dependencies for consistent deployment.",
  "Kubernetes orchestrates containerized applications across multiple hosts.",
  "GraphQL provides a flexible query language for APIs with precise data fetching.",
  "REST APIs use HTTP methods for stateless client-server communication.",
  "WebSockets enable real-time bidirectional communication between clients and servers.",
  "gRPC uses Protocol Buffers for efficient remote procedure calls.",
  "Message queues decouple producers and consumers for asynchronous processing.",
  "Load balancers distribute traffic across multiple servers for high availability.",
  "CDNs cache content at edge locations for faster delivery to users.",
  "CI/CD pipelines automate building, testing, and deploying applications.",
  "Infrastructure as Code manages cloud resources using declarative configuration files.",
  "Observability encompasses logging, metrics, and tracing for system monitoring.",
];

// =============================================================================
// Helpers
// =============================================================================

interface BenchmarkResult {
  name: string;
  category: string;
  duration_ms: number;
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatVector(v: number[], maxDims = 5): string {
  const preview = v.slice(0, maxDims).map(n => n.toFixed(4)).join(", ");
  return `[${preview}, ...] (${v.length} dims)`;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function stats(durations: number[]): string {
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const p99 = percentile(durations, 99);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  return `avg=${formatDuration(avg)} p50=${formatDuration(p50)} p95=${formatDuration(p95)} p99=${formatDuration(p99)} min=${formatDuration(min)} max=${formatDuration(max)}`;
}

// =============================================================================
// Benchmark: Embedding
// =============================================================================

async function benchmarkEmbed(llm: OpenAILLM): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Test 1: Single embed (short text)
  console.log("\n📝 Test 1: Single Embed (short)");
  const t1Start = performance.now();
  try {
    const result = await llm.embed(EMBED_SHORT_TEXTS[0]!);
    const duration = performance.now() - t1Start;
    results.push({
      name: "Single Embed (short)",
      category: "embed",
      duration_ms: duration,
      success: true,
      details: { dims: result?.embedding.length },
    });
    console.log(`  ✅ ${formatDuration(duration)} | ${result?.embedding.length} dims`);
  } catch (e: any) {
    results.push({ name: "Single Embed (short)", category: "embed", duration_ms: performance.now() - t1Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 2: Single embed (medium text)
  console.log("📝 Test 2: Single Embed (medium)");
  const t2Start = performance.now();
  try {
    const result = await llm.embed(EMBED_MEDIUM_TEXTS[0]!);
    const duration = performance.now() - t2Start;
    results.push({
      name: "Single Embed (medium)",
      category: "embed",
      duration_ms: duration,
      success: true,
      details: { dims: result?.embedding.length, chars: EMBED_MEDIUM_TEXTS[0]!.length },
    });
    console.log(`  ✅ ${formatDuration(duration)} | ${result?.embedding.length} dims | ${EMBED_MEDIUM_TEXTS[0]!.length} chars`);
  } catch (e: any) {
    results.push({ name: "Single Embed (medium)", category: "embed", duration_ms: performance.now() - t2Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 3: Single embed (long text)
  console.log("📝 Test 3: Single Embed (long)");
  const t3Start = performance.now();
  try {
    const result = await llm.embed(EMBED_LONG_TEXTS[0]!);
    const duration = performance.now() - t3Start;
    results.push({
      name: "Single Embed (long)",
      category: "embed",
      duration_ms: duration,
      success: true,
      details: { dims: result?.embedding.length, chars: EMBED_LONG_TEXTS[0]!.length },
    });
    console.log(`  ✅ ${formatDuration(duration)} | ${result?.embedding.length} dims | ${EMBED_LONG_TEXTS[0]!.length} chars`);
  } catch (e: any) {
    results.push({ name: "Single Embed (long)", category: "embed", duration_ms: performance.now() - t3Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 4: Batch embed (5 texts)
  console.log("📝 Test 4: Batch Embed (5 texts)");
  const t4Start = performance.now();
  try {
    const batchResults = await llm.embedBatch(EMBED_MEDIUM_TEXTS);
    const duration = performance.now() - t4Start;
    const successCount = batchResults.filter(r => r !== null).length;
    results.push({
      name: "Batch Embed (5 texts)",
      category: "embed",
      duration_ms: duration,
      success: successCount === EMBED_MEDIUM_TEXTS.length,
      details: { total: EMBED_MEDIUM_TEXTS.length, success: successCount, avg: formatDuration(duration / EMBED_MEDIUM_TEXTS.length) },
    });
    console.log(`  ✅ ${successCount}/${EMBED_MEDIUM_TEXTS.length} | ${formatDuration(duration)} | avg ${formatDuration(duration / EMBED_MEDIUM_TEXTS.length)}/text`);
  } catch (e: any) {
    results.push({ name: "Batch Embed (5 texts)", category: "embed", duration_ms: performance.now() - t4Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 5: Batch embed (15 texts)
  console.log("📝 Test 5: Batch Embed (15 texts)");
  const all15 = [...EMBED_MEDIUM_TEXTS, ...EMBED_LONG_TEXTS, ...EMBED_SHORT_TEXTS, ...EMBED_VIETNAMESE_TEXTS.slice(0, 2)];
  const t5Start = performance.now();
  try {
    const batchResults = await llm.embedBatch(all15);
    const duration = performance.now() - t5Start;
    const successCount = batchResults.filter(r => r !== null).length;
    results.push({
      name: "Batch Embed (15 texts)",
      category: "embed",
      duration_ms: duration,
      success: successCount === all15.length,
      details: { total: all15.length, success: successCount, avg: formatDuration(duration / all15.length) },
    });
    console.log(`  ✅ ${successCount}/${all15.length} | ${formatDuration(duration)} | avg ${formatDuration(duration / all15.length)}/text`);
  } catch (e: any) {
    results.push({ name: "Batch Embed (15 texts)", category: "embed", duration_ms: performance.now() - t5Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 6: Vietnamese embed
  console.log("📝 Test 6: Vietnamese Embed");
  const t6Start = performance.now();
  try {
    const result = await llm.embed(EMBED_VIETNAMESE_TEXTS[0]!);
    const duration = performance.now() - t6Start;
    results.push({
      name: "Vietnamese Embed",
      category: "embed",
      duration_ms: duration,
      success: true,
      details: { dims: result?.embedding.length },
    });
    console.log(`  ✅ ${formatDuration(duration)} | ${result?.embedding.length} dims`);
  } catch (e: any) {
    results.push({ name: "Vietnamese Embed", category: "embed", duration_ms: performance.now() - t6Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 7: Vietnamese batch embed
  console.log("📝 Test 7: Vietnamese Batch Embed (5 texts)");
  const t7Start = performance.now();
  try {
    const batchResults = await llm.embedBatch(EMBED_VIETNAMESE_TEXTS);
    const duration = performance.now() - t7Start;
    const successCount = batchResults.filter(r => r !== null).length;
    results.push({
      name: "Vietnamese Batch Embed (5)",
      category: "embed",
      duration_ms: duration,
      success: successCount === EMBED_VIETNAMESE_TEXTS.length,
      details: { total: EMBED_VIETNAMESE_TEXTS.length, success: successCount },
    });
    console.log(`  ✅ ${successCount}/${EMBED_VIETNAMESE_TEXTS.length} | ${formatDuration(duration)}`);
  } catch (e: any) {
    results.push({ name: "Vietnamese Batch Embed (5)", category: "embed", duration_ms: performance.now() - t7Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 8: Multilingual embed
  console.log("📝 Test 8: Multilingual Embed (EN+VI)");
  const t8Start = performance.now();
  try {
    const batchResults = await llm.embedBatch(EMBED_MULTILINGUAL_TEXTS);
    const duration = performance.now() - t8Start;
    const successCount = batchResults.filter(r => r !== null).length;
    results.push({
      name: "Multilingual Embed (EN+VI)",
      category: "embed",
      duration_ms: duration,
      success: successCount === EMBED_MULTILINGUAL_TEXTS.length,
      details: { total: EMBED_MULTILINGUAL_TEXTS.length, success: successCount },
    });
    console.log(`  ✅ ${successCount}/${EMBED_MULTILINGUAL_TEXTS.length} | ${formatDuration(duration)}`);
  } catch (e: any) {
    results.push({ name: "Multilingual Embed (EN+VI)", category: "embed", duration_ms: performance.now() - t8Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 9: Embed consistency
  console.log("📝 Test 9: Embed Consistency");
  const t9Start = performance.now();
  try {
    const r1 = await llm.embed("test consistency check");
    const r2 = await llm.embed("test consistency check");
    const duration = performance.now() - t9Start;
    const isConsistent = r1 && r2 &&
      r1.embedding.length === r2.embedding.length &&
      r1.embedding.every((v, i) => Math.abs(v - r2!.embedding[i]!) < 0.0001);
    results.push({
      name: "Embed Consistency",
      category: "embed",
      duration_ms: duration,
      success: !!isConsistent,
      details: { consistent: isConsistent },
    });
    console.log(`  ${isConsistent ? "✅" : "❌"} Consistent: ${isConsistent} | ${formatDuration(duration)}`);
  } catch (e: any) {
    results.push({ name: "Embed Consistency", category: "embed", duration_ms: performance.now() - t9Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 10: Embed latency distribution (10 sequential calls)
  console.log("📝 Test 10: Embed Latency Distribution (10 calls)");
  const embedDurations: number[] = [];
  const t10Start = performance.now();
  try {
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await llm.embed(EMBED_SHORT_TEXTS[i % EMBED_SHORT_TEXTS.length]!);
      embedDurations.push(performance.now() - start);
    }
    const duration = performance.now() - t10Start;
    results.push({
      name: "Embed Latency Distribution (10)",
      category: "embed",
      duration_ms: duration,
      success: true,
      details: { stats: stats(embedDurations) },
    });
    console.log(`  ✅ ${stats(embedDurations)}`);
  } catch (e: any) {
    results.push({ name: "Embed Latency Distribution (10)", category: "embed", duration_ms: performance.now() - t10Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 11: Concurrent embed (5 parallel)
  console.log("📝 Test 11: Concurrent Embed (5 parallel)");
  const t11Start = performance.now();
  try {
    const promises = EMBED_SHORT_TEXTS.map(t => llm.embed(t));
    const results11 = await Promise.all(promises);
    const duration = performance.now() - t11Start;
    const successCount = results11.filter(r => r !== null).length;
    results.push({
      name: "Concurrent Embed (5 parallel)",
      category: "embed",
      duration_ms: duration,
      success: successCount === EMBED_SHORT_TEXTS.length,
      details: { total: EMBED_SHORT_TEXTS.length, success: successCount, avg: formatDuration(duration / EMBED_SHORT_TEXTS.length) },
    });
    console.log(`  ✅ ${successCount}/${EMBED_SHORT_TEXTS.length} | ${formatDuration(duration)} | avg ${formatDuration(duration / EMBED_SHORT_TEXTS.length)}/text`);
  } catch (e: any) {
    results.push({ name: "Concurrent Embed (5 parallel)", category: "embed", duration_ms: performance.now() - t11Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 12: Concurrent embed (10 parallel)
  console.log("📝 Test 12: Concurrent Embed (10 parallel)");
  const t12Start = performance.now();
  try {
    const texts10 = [...EMBED_SHORT_TEXTS, ...EMBED_MEDIUM_TEXTS.slice(0, 5)];
    const promises = texts10.map(t => llm.embed(t));
    const results12 = await Promise.all(promises);
    const duration = performance.now() - t12Start;
    const successCount = results12.filter(r => r !== null).length;
    results.push({
      name: "Concurrent Embed (10 parallel)",
      category: "embed",
      duration_ms: duration,
      success: successCount === texts10.length,
      details: { total: texts10.length, success: successCount, avg: formatDuration(duration / texts10.length) },
    });
    console.log(`  ✅ ${successCount}/${texts10.length} | ${formatDuration(duration)} | avg ${formatDuration(duration / texts10.length)}/text`);
  } catch (e: any) {
    results.push({ name: "Concurrent Embed (10 parallel)", category: "embed", duration_ms: performance.now() - t12Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  return results;
}

// =============================================================================
// Benchmark: Reranking
// =============================================================================

async function benchmarkRerank(llm: OpenAILLM): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Test 1: Rerank 7 docs
  console.log("\n📝 Test 1: Rerank (7 docs)");
  const t1Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[0]!, RERANK_DOCS_7.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t1Start;
    const scores = r.results.map(x => x.score);
    results.push({
      name: "Rerank (7 docs)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { docs: 7, topScore: (scores[0]! * 100).toFixed(1) + "%" },
    });
    console.log(`  ✅ ${formatDuration(duration)} | top: ${(scores[0]! * 100).toFixed(1)}%`);
  } catch (e: any) {
    results.push({ name: "Rerank (7 docs)", category: "rerank", duration_ms: performance.now() - t1Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 2: Rerank 15 docs
  console.log("📝 Test 2: Rerank (15 docs)");
  const t2Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[0]!, RERANK_DOCS_15.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t2Start;
    results.push({
      name: "Rerank (15 docs)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { docs: 15, topScore: (r.results[0]!.score * 100).toFixed(1) + "%" },
    });
    console.log(`  ✅ ${formatDuration(duration)} | top: ${(r.results[0]!.score * 100).toFixed(1)}%`);
  } catch (e: any) {
    results.push({ name: "Rerank (15 docs)", category: "rerank", duration_ms: performance.now() - t2Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 3: Rerank 30 docs
  console.log("📝 Test 3: Rerank (30 docs)");
  const t3Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[0]!, RERANK_DOCS_30.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t3Start;
    results.push({
      name: "Rerank (30 docs)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { docs: 30, topScore: (r.results[0]!.score * 100).toFixed(1) + "%" },
    });
    console.log(`  ✅ ${formatDuration(duration)} | top: ${(r.results[0]!.score * 100).toFixed(1)}%`);
  } catch (e: any) {
    results.push({ name: "Rerank (30 docs)", category: "rerank", duration_ms: performance.now() - t3Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 4: Rerank 3 docs (minimal)
  console.log("📝 Test 4: Rerank (3 docs)");
  const t4Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[0]!, RERANK_DOCS_7.slice(0, 3).map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t4Start;
    results.push({
      name: "Rerank (3 docs)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { docs: 3 },
    });
    console.log(`  ✅ ${formatDuration(duration)}`);
  } catch (e: any) {
    results.push({ name: "Rerank (3 docs)", category: "rerank", duration_ms: performance.now() - t4Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 5: Vietnamese query rerank
  console.log("📝 Test 5: Vietnamese Query Rerank");
  const t5Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[3]!, RERANK_DOCS_7.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t5Start;
    results.push({
      name: "Vietnamese Query Rerank",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { topScore: (r.results[0]!.score * 100).toFixed(1) + "%" },
    });
    console.log(`  ✅ ${formatDuration(duration)} | top: ${(r.results[0]!.score * 100).toFixed(1)}%`);
  } catch (e: any) {
    results.push({ name: "Vietnamese Query Rerank", category: "rerank", duration_ms: performance.now() - t5Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 6: Score ordering verification
  console.log("📝 Test 6: Score Ordering Verification");
  const t6Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[0]!, RERANK_DOCS_7.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t6Start;
    const scores = r.results.map(x => x.score);
    const isSorted = scores.every((s, i) => i === 0 || s <= scores[i - 1]!);
    results.push({
      name: "Score Ordering Verification",
      category: "rerank",
      duration_ms: duration,
      success: isSorted,
      details: { sorted: isSorted, scores: scores.map(s => (s * 100).toFixed(1) + "%") },
    });
    console.log(`  ${isSorted ? "✅" : "❌"} Sorted: ${isSorted}`);
    console.log(`  ${scores.map(s => (s * 100).toFixed(1) + "%").join(" > ")}`);
  } catch (e: any) {
    results.push({ name: "Score Ordering Verification", category: "rerank", duration_ms: performance.now() - t6Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 7: Multiple queries consistency
  console.log("📝 Test 7: Multiple Queries (5 queries)");
  const t7Start = performance.now();
  try {
    const allDurations: number[] = [];
    for (const query of RERANK_QUERIES) {
      const start = performance.now();
      await llm.rerank(query, RERANK_DOCS_7.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
      allDurations.push(performance.now() - start);
    }
    const duration = performance.now() - t7Start;
    results.push({
      name: "Multiple Queries (5 queries)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { queries: 5, stats: stats(allDurations) },
    });
    console.log(`  ✅ 5 queries | ${formatDuration(duration)} | ${stats(allDurations)}`);
  } catch (e: any) {
    results.push({ name: "Multiple Queries (5 queries)", category: "rerank", duration_ms: performance.now() - t7Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 8: Rerank latency distribution (10 calls)
  console.log("📝 Test 8: Rerank Latency Distribution (10 calls)");
  const rerankDurations: number[] = [];
  const t8Start = performance.now();
  try {
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await llm.rerank(RERANK_QUERIES[i % RERANK_QUERIES.length]!, RERANK_DOCS_7.map((t, j) => ({ text: t, file: `doc-${j}.md` })));
      rerankDurations.push(performance.now() - start);
    }
    const duration = performance.now() - t8Start;
    results.push({
      name: "Rerank Latency Distribution (10)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { stats: stats(rerankDurations) },
    });
    console.log(`  ✅ ${stats(rerankDurations)}`);
  } catch (e: any) {
    results.push({ name: "Rerank Latency Distribution (10)", category: "rerank", duration_ms: performance.now() - t8Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 9: Concurrent rerank (3 parallel)
  console.log("📝 Test 9: Concurrent Rerank (3 parallel)");
  const t9Start = performance.now();
  try {
    const promises = RERANK_QUERIES.slice(0, 3).map(q =>
      llm.rerank(q, RERANK_DOCS_7.map((t, i) => ({ text: t, file: `doc-${i}.md` })))
    );
    const r9 = await Promise.all(promises);
    const duration = performance.now() - t9Start;
    results.push({
      name: "Concurrent Rerank (3 parallel)",
      category: "rerank",
      duration_ms: duration,
      success: r9.length === 3,
      details: { total: 3, success: r9.length, avg: formatDuration(duration / 3) },
    });
    console.log(`  ✅ ${r9.length}/3 | ${formatDuration(duration)} | avg ${formatDuration(duration / 3)}/query`);
  } catch (e: any) {
    results.push({ name: "Concurrent Rerank (3 parallel)", category: "rerank", duration_ms: performance.now() - t9Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  // Test 10: Score distribution analysis
  console.log("📝 Test 10: Score Distribution (30 docs)");
  const t10Start = performance.now();
  try {
    const r = await llm.rerank(RERANK_QUERIES[0]!, RERANK_DOCS_30.map((t, i) => ({ text: t, file: `doc-${i}.md` })));
    const duration = performance.now() - t10Start;
    const scores = r.results.map(x => x.score);
    const high = scores.filter(s => s > 0.5).length;
    const medium = scores.filter(s => s > 0.1 && s <= 0.5).length;
    const low = scores.filter(s => s <= 0.1).length;
    results.push({
      name: "Score Distribution (30 docs)",
      category: "rerank",
      duration_ms: duration,
      success: true,
      details: { high, medium, low, total: scores.length },
    });
    console.log(`  ✅ High(>50%): ${high} | Medium(10-50%): ${medium} | Low(<10%): ${low}`);
  } catch (e: any) {
    results.push({ name: "Score Distribution (30 docs)", category: "rerank", duration_ms: performance.now() - t10Start, success: false, error: e.message });
    console.log(`  ❌ ${e.message}`);
  }

  return results;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const embedOnly = args.includes("--embed-only");
  const rerankOnly = args.includes("--rerank-only");
  const stress = args.includes("--stress");

  console.log("🚀 LiteLLM Benchmark (Comprehensive)");
  console.log("=====================================");
  console.log(`Base URL: ${LITELLM_BASE_URL}`);
  console.log(`Embed Model: ${EMBED_MODEL}`);
  console.log(`Rerank Model: ${RERANK_MODEL}`);
  console.log(`Generate Model: ${GENERATE_MODEL}`);
  console.log(`API Key: ${LITELLM_API_KEY ? "***" + LITELLM_API_KEY.slice(-4) : "NOT SET"}`);
  console.log(`Mode: ${stress ? "STRESS" : "NORMAL"}`);

  if (!LITELLM_API_KEY) {
    console.error("\n❌ LITELLM_API_KEY not set");
    process.exit(1);
  }

  const llm = new OpenAILLM({
    baseUrl: LITELLM_BASE_URL,
    apiKey: LITELLM_API_KEY,
    embedModel: EMBED_MODEL,
    generateModel: GENERATE_MODEL,
    rerankModel: RERANK_MODEL,
  });

  const allResults: BenchmarkResult[] = [];

  // Run embed benchmarks
  if (!rerankOnly) {
    console.log("\n" + "=".repeat(60));
    console.log("📊 EMBEDDING BENCHMARKS (12 tests)");
    console.log("=".repeat(60));
    const embedResults = await benchmarkEmbed(llm);
    allResults.push(...embedResults);
  }

  // Run rerank benchmarks
  if (!embedOnly) {
    console.log("\n" + "=".repeat(60));
    console.log("📊 RERANKING BENCHMARKS (10 tests)");
    console.log("=".repeat(60));
    const rerankResults = await benchmarkRerank(llm);
    allResults.push(...rerankResults);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 SUMMARY");
  console.log("=".repeat(60));

  const passed = allResults.filter(r => r.success).length;
  const failed = allResults.filter(r => !r.success).length;
  const totalDuration = allResults.reduce((sum, r) => sum + r.duration_ms, 0);

  const embedResults = allResults.filter(r => r.category === "embed");
  const rerankResults = allResults.filter(r => r.category === "rerank");

  console.log(`\nTotal: ${allResults.length} tests`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⏱️  Total duration: ${formatDuration(totalDuration)}`);

  console.log(`\n📊 By Category:`);
  console.log(`  Embed: ${embedResults.filter(r => r.success).length}/${embedResults.length} passed`);
  console.log(`  Rerank: ${rerankResults.filter(r => r.success).length}/${rerankResults.length} passed`);

  // Print failed tests
  if (failed > 0) {
    console.log("\n❌ Failed Tests:");
    for (const r of allResults.filter(r => !r.success)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }

  // Print timing table
  console.log("\n⏱️  Timing:");
  for (const r of allResults) {
    const status = r.success ? "✅" : "❌";
    console.log(`  ${status} [${r.category}] ${r.name}: ${formatDuration(r.duration_ms)}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
