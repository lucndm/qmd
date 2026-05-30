# Deployment Guide

## Installation Methods

### npm / bun (Recommended)

```sh
# Global install
npm install -g @tobilu/qmd
# or
bun install -g @tobilu/qmd

# Run directly without installing
npx @tobilu/qmd ...
bunx @tobilu/qmd ...
```

### From Source

```sh
git clone https://github.com/tobi/qmd
cd qmd
pnpm install
pnpm run build
pnpm link
```

### Docker

```sh
# Build
docker build -t qmd .

# Run
docker run -v ~/.cache/qmd:/home/qmd/.cache/qmd qmd status

# MCP server
docker run -p 8183:8183 -v ~/.cache/qmd:/home/qmd/.cache/qmd qmd mcp --http
```

**Dockerfile details:**
- Multi-stage build (builder + runtime)
- Base: `node:22.16.0-slim`
- Exposes port 8183
- Runs as non-root `qmd` user
- Models downloaded on first use (mount `~/.cache/qmd` as volume)

## MCP Server Setup

### Claude Desktop (stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

Install the plugin (recommended):
```bash
claude plugin marketplace add tobi/qmd
claude plugin install qmd@qmd
```

Or configure manually in `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

### HTTP Transport (Shared Server)

```sh
# Foreground
qmd mcp --http                    # localhost:8181
qmd mcp --http --port 8080        # custom port

# Background daemon
qmd mcp --http --daemon           # start, writes PID to ~/.cache/qmd/mcp.pid
qmd mcp stop                      # stop via PID file
qmd status                        # shows "MCP: running (PID ...)" when active
```

**Endpoints:**
- `POST /mcp` — MCP Streamable HTTP (JSON, stateless)
- `GET /health` — Liveness check with uptime

Point any MCP client at `http://localhost:8181/mcp` to connect.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XDG_CACHE_HOME` | `~/.cache` | Cache directory location |
| `QMD_LLAMA_GPU` | `auto` | Force GPU backend (`metal`, `vulkan`, `cuda`) or `false` to disable |
| `QMD_FORCE_CPU` | unset | Set `1`/`true` to force CPU mode before GPU probing |
| `QMD_EMBED_PARALLELISM` | automatic | Override embedding parallelism (1-8). Windows CUDA defaults to 1 |
| `QMD_EMBED_MODEL` | embeddinggemma | Override embedding model (HuggingFace URI) |
| `QMD_EDITOR_URI` | VS Code template | Editor link template for TTY output |
| `QMD_LLM_BACKEND` | `local` | LLM backend: `local` (GGUF) or `api` (OpenAI-compatible) |
| `QMD_API_BASE_URL` | `http://litellm:4000` | API base URL when backend is `api` |
| `QMD_API_KEY` | unset | API key for OpenAI-compatible backend |
| `QMD_GENERATE_MODEL` | unset | Model name for query expansion (API mode) |
| `QMD_RERANK_MODEL` | unset | Model name for reranking (API mode) |

## Configuration File

QMD supports YAML configuration via `qmd.yml`:

```yaml
collections:
  docs:
    path: /path/to/docs
    pattern: "**/*.md"
    ignore:
      - "node_modules/**"
      - "*.tmp.md"
  notes:
    path: ~/notes
    includeByDefault: true

models:
  backend: local  # or "api"
  embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
  generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf"
  rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"

editor_uri: "vscode://file/{path}:{line}:{col}"
```

## Index Storage

```
~/.cache/qmd/
├── index.sqlite              # Main database (portable)
├── mcp.pid                   # MCP daemon PID file
└── models/                   # Downloaded GGUF models (~2GB total)
    ├── embeddinggemma-300M-Q8_0.gguf
    ├── qwen3-reranker-0.6b-q8_0.gguf
    └── qmd-query-expansion-1.7B-q4_k_m.gguf
```

Models are auto-downloaded from HuggingFace on first use.

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| Node.js | >= 22.0.0 |
| Bun | >= 1.0.0 (optional) |
| RAM | 4GB (8GB recommended for all 3 models) |
| Disk | 3GB (models + index) |
| GPU | Optional (Metal/CUDA/Vulkan for faster inference) |
| macOS | Homebrew SQLite for Bun (`brew install sqlite`) |

## CI/CD

### GitHub Actions

```yaml
- name: Install QMD
  run: npm install -g @tobilu/qmd

- name: Index docs
  run: |
    qmd collection add ./docs --name docs
    qmd update
    qmd embed

- name: Search
  run: qmd query "deployment guide" --json
```

### Publishing

```sh
# Release workflow
./scripts/release.sh <version>

# Or use the release skill
/release <version>
```

## Troubleshooting

### sqlite-vec extension not found (Bun on macOS)

```sh
# Install Homebrew SQLite
brew install sqlite

# Bun will auto-detect it at /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
```

### Models not downloading

```sh
# Check model cache
ls ~/.cache/qmd/models/

# Force re-download by deleting cached models
rm ~/.cache/qmd/models/*.gguf
qmd embed
```

### Database locked

```sh
# Check for running MCP daemon
qmd status

# Stop daemon if running
qmd mcp stop
```

### GPU not detected

```sh
# Force specific GPU backend
QMD_LLAMA_GPU=metal qmd query "test"    # macOS
QMD_LLAMA_GPU=cuda qmd query "test"     # NVIDIA
QMD_LLAMA_GPU=vulkan qmd query "test"   # Cross-platform

# Force CPU mode
QMD_FORCE_CPU=1 qmd query "test"
```
