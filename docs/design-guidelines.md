# Design Guidelines

## CLI Output Philosophy

QMD's CLI output is designed for two audiences:
1. **Humans in terminals** — Color-coded, scannable, with clickable links
2. **AI agents** — Structured formats (JSON, CSV, files) for programmatic consumption

## TTY Detection

QMD automatically detects whether stdout is a TTY:

| Context | Behavior |
|---------|----------|
| Terminal (TTY) | Colors, hyperlinks, score formatting |
| Pipe / redirect | Plain text, no escape sequences |
| `NO_COLOR` env | Colors disabled regardless of TTY |

## Score Display

Scores are color-coded by relevance:

| Range | Color | Meaning |
|-------|-------|---------|
| 0.8 - 1.0 | Green | Highly relevant |
| 0.5 - 0.79 | Yellow | Moderately relevant |
| 0.0 - 0.49 | Dim | Low relevance |

Format: `Score: 93%` (percentage, rounded)

## Terminal Hyperlinks

When stdout is a TTY, file paths are rendered as clickable OSC 8 hyperlinks:

```
docs/guide.md:42 #a1b2c3
```

Clicking opens the file in the user's editor at the specified line.

### Editor URI Templates

Configured via `QMD_EDITOR_URI` or `editor_uri` in config:

| Editor | Template |
|--------|----------|
| VS Code (default) | `vscode://file/{path}:{line}:{col}` |
| Cursor | `cursor://file/{path}:{line}:{col}` |
| Zed | `zed://file/{path}:{line}:{col}` |
| Sublime Text | `subl://open?url=file://{path}&line={line}` |

**Placeholders:**
- `{path}` — Absolute filesystem path (URI-encoded)
- `{line}` — 1-based line number
- `{col}` / `{column}` — 1-based column number

## Default Output Format

```
docs/guide.md:42 #a1b2c3
Title: Software Craftsmanship
Context: Work documentation
Score: 93%

This section covers the **craftsmanship** of building
quality software with attention to detail.
See also: engineering principles


notes/meeting.md:15 #d4e5f6
Title: Q4 Planning
Context: Personal notes and ideas
Score: 67%

Discussion about code quality and craftsmanship
in the development process.
```

**Elements:**
- `path:line` — Clickable file reference
- `#docid` — 6-char content hash for `qmd get`
- `Title` — Extracted from first heading or filename
- `Context` — Path context if configured
- `Score` — Color-coded relevance
- `Snippet` — Context around match with query terms highlighted

## Output Formats

### JSON (`--json`)

```json
[
  {
    "docid": "#a1b2c3",
    "file": "docs/guide.md",
    "title": "Software Craftsmanship",
    "score": 0.93,
    "context": "Work documentation",
    "line": 42,
    "snippet": "This section covers the **craftsmanship** of..."
  }
]
```

### CSV (`--csv`)

```csv
docid,file,title,score,context,line,snippet
#a1b2c3,docs/guide.md,Software Craftsmanship,0.93,Work documentation,42,"This section covers..."
```

### Markdown (`--md`)

```markdown
## Results

### [Software Craftsmanship](docs/guide.md:42)
**Score:** 93% | **Context:** Work documentation

This section covers the **craftsmanship** of building...
```

### Files Only (`--files`)

```
#a1b2c3 0.93 docs/guide.md Work documentation
#d4e5f6 0.67 notes/meeting.md Personal notes
```

Format: `docid score filepath context`

### XML (`--xml`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<results>
  <result>
    <docid>#a1b2c3</docid>
    <file>docs/guide.md</file>
    <title>Software Craftsmanship</title>
    <score>0.93</score>
    <context>Work documentation</context>
    <line>42</line>
    <snippet>This section covers...</snippet>
  </result>
</results>
```

## CLI Command Structure

Commands follow a consistent pattern:

```
qmd <noun> <verb> [args] [options]
```

Examples:
```
qmd collection add ./docs --name docs
qmd context add qmd://docs "Work documentation"
qmd query "authentication" -n 10 --min-score 0.3
qmd get docs/readme.md --full
```

## Progress Indicators

Long-running operations show progress:

```
[1/150] indexing docs/guide.md
[2/150] indexing docs/api.md
...
```

Embedding shows model loading:
```
Loading embedding model...
[1/250] embedding chunk 0 of docs/guide.md
[2/250] embedding chunk 1 of docs/guide.md
...
```

## Error Messages

Error messages are actionable:

```
Error: sqlite-vec extension is unavailable.
On macOS with Bun, install Homebrew SQLite: brew install sqlite
Or install qmd with npm instead: npm install -g @tobilu/qmd
```

```
Error: Collection "docs" not found.
Available collections: notes, meetings
Run 'qmd collection list' to see all collections.
```

## MCP Tool Response Format

MCP tools return structured content:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 5 results:\n\n1. docs/guide.md (93%)\n..."
    }
  ]
}
```

For `query` tool with typed sub-queries:
```json
{
  "searches": [
    { "type": "lex", "query": "\"connection pool\" timeout" },
    { "type": "vec", "query": "why do connections time out" }
  ]
}
```

## Accessibility

- All output respects `NO_COLOR` environment variable
- Non-TTY output has no ANSI escape sequences
- Scores displayed as percentages (not raw floats)
- File paths are absolute or collection-relative (never ambiguous)
