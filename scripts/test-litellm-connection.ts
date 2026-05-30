#!/usr/bin/env bun
/**
 * Quick LiteLLM Connection Test
 *
 * Usage:
 *   bun scripts/test-litellm-connection.ts
 *
 * Environment:
 *   LITELLM_API_KEY - API key for LiteLLM proxy
 */

import { OpenAILLM } from "../src/llm-openai.js";

const LITELLM_BASE_URL = "https://z.minhluc.info/";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "";

async function testConnection() {
  console.log("🔌 LiteLLM Connection Test");
  console.log("==========================");
  console.log(`URL: ${LITELLM_BASE_URL}`);
  console.log(`API Key: ${LITELLM_API_KEY ? "***" + LITELLM_API_KEY.slice(-4) : "NOT SET"}`);

  if (!LITELLM_API_KEY) {
    console.error("\n❌ LITELLM_API_KEY not set");
    console.log("\nSet it with:");
    console.log('  export LITELLM_API_KEY="your-key"');
    process.exit(1);
  }

  const llm = new OpenAILLM({
    baseUrl: LITELLM_BASE_URL,
    apiKey: LITELLM_API_KEY,
    embedModel: "qwen3-embedding-small",
    generateModel: "MiniMax-M2.7",
    rerankModel: "qwen3-reranker-small",
  });

  // Test 1: Health check via models endpoint
  console.log("\n1️⃣ Health Check (GET /v1/models)");
  try {
    const res = await fetch(`${LITELLM_BASE_URL}v1/models`, {
      headers: { "Authorization": `Bearer ${LITELLM_API_KEY}` },
    });
    if (res.ok) {
      const data = await res.json() as { data: Array<{ id: string }> };
      console.log(`  ✅ Connected. ${data.data?.length || 0} models available.`);
    } else {
      console.log(`  ❌ Failed: ${res.status} ${await res.text()}`);
    }
  } catch (e: any) {
    console.log(`  ❌ Connection failed: ${e.message}`);
    process.exit(1);
  }

  // Test 2: Embed
  console.log("\n2️⃣ Embed Test");
  try {
    const result = await llm.embed("Hello world");
    if (result) {
      console.log(`  ✅ Embed success`);
      console.log(`  Model: ${result.model}`);
      console.log(`  Dimensions: ${result.embedding.length}`);
      console.log(`  Preview: [${result.embedding.slice(0, 3).map(n => n.toFixed(4)).join(", ")}...]`);
    } else {
      console.log(`  ❌ Embed returned null`);
    }
  } catch (e: any) {
    console.log(`  ❌ Embed failed: ${e.message}`);
  }

  // Test 3: Generate
  console.log("\n3️⃣ Generate Test");
  try {
    const result = await llm.generate("Say hello in 5 words or less.", { maxTokens: 20 });
    if (result) {
      console.log(`  ✅ Generate success`);
      console.log(`  Model: ${result.model}`);
      console.log(`  Text: "${result.text}"`);
    } else {
      console.log(`  ❌ Generate returned null`);
    }
  } catch (e: any) {
    console.log(`  ❌ Generate failed: ${e.message}`);
  }

  // Test 4: Rerank
  console.log("\n4️⃣ Rerank Test");
  try {
    const result = await llm.rerank(
      "graph RAG",
      [
        { text: "LightRAG is a graph-based RAG framework", file: "a.md" },
        { text: "Meilisearch is a search engine", file: "b.md" },
        { text: "Graph databases store relationships", file: "c.md" },
      ],
    );
    console.log(`  ✅ Rerank success`);
    console.log(`  Model: ${result.model}`);
    for (const r of result.results) {
      console.log(`    ${r.file}: ${(r.score * 100).toFixed(1)}%`);
    }
  } catch (e: any) {
    console.log(`  ❌ Rerank failed: ${e.message}`);
  }

  console.log("\n✅ Connection test complete");
}

testConnection().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
