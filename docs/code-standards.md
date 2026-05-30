# Code Standards

## Language & Runtime

- **TypeScript** with ESNext target, strict mode enabled
- **Module system:** ESModules (`"type": "module"`)
- **Runtimes:** Node.js >= 22 and Bun >= 1.0.0
- **Package manager:** pnpm 10.12.1

## TypeScript Configuration

Strict mode with these key flags:
```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true
}
```

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `store.helpers.ts` |
| Classes | PascalCase | `LlamaCpp`, `OpenAILLM` |
| Interfaces | PascalCase | `QMDStore`, `SearchOptions` |
| Functions | camelCase | `hybridQuery`, `createStore` |
| Constants | UPPER_SNAKE | `DEFAULT_EMBED_MODEL`, `CHUNK_SIZE_TOKENS` |
| Types | PascalCase | `HybridQueryResult`, `DocumentResult` |
| CLI commands | kebab-case | `collection add`, `multi-get` |

## File Organization

- **One concern per file** — `store.ts` for data, `llm.ts` for models, `db.ts` for database
- **Re-exports via index.ts** — Public API surface through `src/index.ts`
- **Types co-located** — Types defined near their implementation, re-exported from index
- **No barrel files** — Direct imports within `src/`, re-exports only at entry point

## Error Handling

```typescript
// Return error objects, don't throw for expected failures
type DocumentNotFound = {
  error: string;
  similarFiles: string[];
};

// Throw for programming errors / invalid input
if (!options.dbPath) {
  throw new Error("dbPath is required");
}

// Try-catch for external operations (file I/O, model loading)
try {
  const content = readFileSync(path, "utf-8");
} catch (err) {
  // Handle gracefully
}
```

## Async Patterns

```typescript
// Lazy initialization with auto-dispose
class LlamaCpp {
  private embedCtx: ILLMSession | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  private async getEmbedCtx(): Promise<ILLMSession> {
    if (!this.embedCtx) {
      this.embedCtx = await this.createEmbedContext();
    }
    this.resetInactivityTimer();
    return this.embedCtx;
  }
}
```

## Database Patterns

```typescript
// Use transactions for multi-statement operations
const insertMany = db.transaction((docs: Document[]) => {
  for (const doc of docs) {
    insertStmt.run(doc.hash, doc.path, doc.title, doc.content);
  }
});

// Prepared statements for repeated queries
const findByPath = db.prepare("SELECT * FROM documents WHERE path = ?");
const doc = findByPath.get(path);
```

## Testing Conventions

- **Framework:** Vitest (Node.js) + Bun test runner
- **Location:** `test/` directory
- **Naming:** `*.test.ts` (e.g., `store.test.ts`, `cli.test.ts`)
- **Parallel:** Disabled (`fileParallelism: false`) for SQLite safety
- **Timeout:** 30s default, 60s for integration tests
- **Preload:** `src/test-preload.ts` for Bun

```typescript
// Test structure
import { describe, it, expect } from "vitest";

describe("feature", () => {
  it("should handle expected case", () => {
    const result = someFunction(input);
    expect(result).toBe(expected);
  });

  it("should handle error case", () => {
    expect(() => someFunction(badInput)).toThrow("expected message");
  });
});
```

## Commit Conventions

Use conventional commits:
```
feat: add vector search with sqlite-vec
fix: handle empty query in hybrid search
refactor: extract chunking logic to separate module
test: add integration tests for MCP server
docs: update README with SDK examples
chore: bump dependencies
```

No AI references in commit messages. Keep commits focused on actual code changes.

## Import Style

```typescript
// Named imports preferred
import { createStore, extractSnippet } from "./store.js";
import type { Database } from "./db.js";

// Dynamic imports for runtime-specific code
const bunSqlite = "bun:" + "sqlite";
const BunDatabase = (await import(bunSqlite)).Database;

// Type-only imports with verbatimModuleSyntax
import type { QMDStore, SearchOptions } from "./index.js";
```

## Code Quality

- **No unused imports** — Clean up after refactoring
- **Explicit return types** on public API functions
- **JSDoc** on exported interfaces and complex functions
- **No `any`** — Use `unknown` with type guards when needed
- **Prefer `const`** — Use `let` only when reassignment is necessary

## Build & Lint

```sh
# Type checking
node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit

# Build (compiles to dist/)
node scripts/build.mjs

# Tests
node scripts/test-all.mjs
```

No ESLint/Prettier configured — rely on TypeScript strict mode and code review.
