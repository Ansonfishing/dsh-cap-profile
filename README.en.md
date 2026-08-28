# dsh-cap-profile

Model capability profiling panel — a plugin for DSH (DeepSeek Harness).

![Panel screenshot](screenshots/cap-profile-panel.png)

## Features

Retrospective analysis of local DSH session history (`~/.dsh/sessions`, zstd-compressed JSONL) to build per-model capability profiles:

- **Model comparison table** — sessions, tool calls, error count, error rate per model (provider / model).
- **Top-5 tools** — most frequently used tools and their per-tool error counts.
- **Top-5 error signatures** — normalized high-frequency error patterns (e.g. `bash: [exit code: 137] OOM`) to quickly spot where a model tends to fail.
- **Time-range filter** — All / Last 7 days / Last 30 days / Last 90 days / Today / Yesterday (anchored to the max date in the data, resilient to system clock drift).

## Highlights

- **Read-only** — the panel only analyzes and displays; it never mutates session data. The route validates a client header plus Origin/Referer and returns 403 on cross-origin requests.
- **Incremental caching** — per-file mtime baseline with background scanning (60s incremental / 24h full re-scan). While the initial scan is still running the route falls back to the last cache or mock data, so it never blocks.
- **Zero runtime dependencies** — pure Node.js (Node ≥ 20; multi-frame zstd decoding via the built-in `zstdDecompressSync`).

## Install

```bash
pnpm add dsh-cap-profile
# or develop locally
dsh web --patch ./cordis.patch.yml --port 3090
```

After install a "Capability Profile" tab appears in the conversation view (order 40). Data is read from the current user's `~/.dsh/sessions`; the first open triggers a background initial scan (~20s for large histories), during which mock data is shown.

## Development

```bash
npm test                     # node --test test/*.test.mjs
dsh web --patch ./cordis.patch.yml --port 3090   # dev preview
```

`test/harness/index.html` is a standalone browser render harness (mock data; `?scenario=mock|live|empty|error&chrome=0`) for verifying the panel render without a dsh environment.

## License

[MIT](LICENSE) © Ansonfishing
