import type {
  LLM,
  EmbeddingResult,
  EmbedOptions,
  GenerateResult,
  GenerateOptions,
  RerankResult,
  RerankDocument,
  RerankOptions,
  Queryable,
  QueryType,
  ModelInfo,
} from "./llm.js";

// =============================================================================
// OpenAI-Compatible API LLM Backend
// =============================================================================

export interface OpenAILLMConfig {
  baseUrl: string;
  apiKey?: string;
  embedModel?: string;
  generateModel?: string;
  rerankModel?: string;
}

export class OpenAILLM implements LLM {
  private readonly config: OpenAILLMConfig;
  private readonly _embedModelName: string;
  private readonly _generateModelName: string;
  private readonly _rerankModelName: string;

  constructor(config: OpenAILLMConfig) {
    this.config = config;
    this._embedModelName = config.embedModel || "qwen3-embedding-small";
    this._generateModelName = config.generateModel || "MiniMax-M2.7";
    this._rerankModelName = config.rerankModel || "qwen3-reranker-small";
  }

  get embedModelName(): string { return this._embedModelName; }
  get generateModelName(): string { return this._generateModelName; }
  get rerankModelName(): string { return this._rerankModelName; }

  // -- Embeddings ----------------------------------------------------------------

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const model = options?.model ?? this._embedModelName;
    const input = stripEmbeddingFormat(text);
    const res = await this.fetch("/v1/embeddings", {
      model,
      input,
      encoding_format: "float",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`embed API error: ${res.status} ${body}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return { embedding: data.data[0]!.embedding, model };
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    const model = options?.model ?? this._embedModelName;
    const input = texts.map(stripEmbeddingFormat);
    const res = await this.fetch("/v1/embeddings", {
      model,
      input,
      encoding_format: "float",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`embedBatch API error: ${res.status} ${body}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map((item) => ({ embedding: item.embedding, model }));
  }

  // -- Generation ----------------------------------------------------------------

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    const model = options?.model ?? this._generateModelName;
    const res = await this.fetch("/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options?.maxTokens ?? 600,
      temperature: options?.temperature ?? 0.7,
      top_p: 0.8,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`generate API error: ${res.status} ${body}`);
    }
    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
    };
    return {
      text: data.choices[0]!.message.content,
      model: data.model,
      done: true,
    };
  }

  // -- Query Expansion -----------------------------------------------------------

  async expandQuery(
    query: string,
    options: { context?: string; includeLexical?: boolean; intent?: string } = {},
  ): Promise<Queryable[]> {
    const includeLexical = options.includeLexical ?? true;
    const intent = options.intent;

    const prompt = intent
      ? `Expand this search query: ${query}\nQuery intent: ${intent}\n\nReturn one query per line in format: type: query (where type is lex, vec, or hyde). Do not include any other text.`
      : `Expand this search query: ${query}\n\nReturn one query per line in format: type: query (where type is lex, vec, or hyde). Do not include any other text.`;

    try {
      const result = await this.generate(prompt, { maxTokens: 600, temperature: 0.7 });
      if (!result) throw new Error("generate returned null");

      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
      const hasQueryTerm = (text: string): boolean => {
        if (queryTerms.length === 0) return true;
        return queryTerms.some(term => text.toLowerCase().includes(term));
      };

      const queryables: Queryable[] = result.text
        .trim()
        .split("\n")
        .map((line): Queryable | null => {
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) return null;
          const type = line.slice(0, colonIdx).trim();
          if (type !== "lex" && type !== "vec" && type !== "hyde") return null;
          const text = line.slice(colonIdx + 1).trim();
          if (!hasQueryTerm(text)) return null;
          return { type: type as QueryType, text };
        })
        .filter((q): q is Queryable => q !== null);

      const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== "lex");
      if (filtered.length > 0) return filtered;
    } catch (e) {
      console.error("expandQuery error:", e);
    }

    // Fallback
    const fallback: Queryable[] = [
      { type: "hyde", text: `Information about ${query}` },
      { type: "lex", text: query },
      { type: "vec", text: query },
    ];
    return includeLexical ? fallback : fallback.filter(q => q.type !== "lex");
  }

  // -- Reranking -----------------------------------------------------------------

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    const model = options?.model ?? this._rerankModelName;
    const res = await this.fetch("/rerank", {
      model,
      query,
      documents: documents.map(d => d.text),
      top_n: documents.length,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`rerank API error: ${res.status} ${body}`);
    }
    const data = await res.json() as {
      results: Array<{ index: number; relevance_score: number }>;
      model: string;
    };
    const results = data.results.map((r) => {
      const doc = documents[r.index]!;
      return { file: doc.file, score: r.relevance_score, index: r.index };
    });
    return { results, model: data.model ?? model };
  }

  // -- Model Info ----------------------------------------------------------------

  async modelExists(model: string): Promise<ModelInfo> {
    try {
      const res = await this.fetchRaw(`/v1/models/${model}`);
      if (res.ok) return { name: model, exists: true };
      return { name: model, exists: false };
    } catch {
      return { name: model, exists: false };
    }
  }

  // -- Lifecycle -----------------------------------------------------------------

  async dispose(): Promise<void> {
    // Stateless HTTP client — nothing to dispose
  }

  // -- Tokenization (character estimation) --------------------------------------

  async tokenize(text: string): Promise<readonly number[]> {
    // Approximate: ~3 chars per token. Return pseudo-token ids.
    const count = Math.ceil(text.length / 3);
    return Array.from({ length: count }, (_, i) => i);
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 3);
  }

  // -- HTTP helpers --------------------------------------------------------------

  private async fetch(path: string, body: unknown): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  }

  private async fetchRaw(path: string): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    return fetch(url, { method: "GET", headers });
  }
}

// =============================================================================
// Embedding format stripping
// =============================================================================

/**
 * Remove nomic-style embedding prefixes added by formatQueryForEmbedding/formatDocForEmbedding.
 * API models don't need these prefixes — remote model handles its own formatting.
 */
function stripEmbeddingFormat(text: string): string {
  // Pattern: "task: search result | query: ..." or "task: search result | query: ..."
  let stripped = text.replace(/^task:\s*[^|]+\|\s*query:\s*/i, "");
  // Pattern: "title: ... | text: ..."
  stripped = stripped.replace(/^title:\s*[^|]*\|\s*text:\s*/i, "");
  return stripped;
}
