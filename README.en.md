# dsh-cap-profile

**Languages: [English](README.en.md) | [中文](README.md)**

Per-model capability profiling — a plugin for DSH (DeepSeek Harness).

![Panel screenshot](screenshots/cap-profile-panel.png)

## Why

The more sessions you run, the harder it is to answer "which model is reliable at what, and where does it tend to fail". Reading raw session logs is slow, and manual tallying misses things.

This plugin turns the session history in `~/.dsh/sessions` into per-model capability profiles, directly answering: per-model session count, tool-call volume, error count, error rate, most-used tools, and top error signatures.

## Quick start

**Prerequisites**: DSH (with web) + pnpm; Node ≥ 24 (zstd decoding uses the built-in `zstdDecompressSync`).

```bash
cd ~/.dsh/profiles/web                      # your DSH web profile directory
pnpm add github:Ansonfishing/dsh-cap-profile
```

Then add `"dsh-cap-profile"` to the `dsh.profile.bundles` array in `package.json` and restart `dsh`. A "Capability Profile" tab appears in the conversation view; the first open triggers a background initial scan (~20s for large histories), during which mock data is shown.

## Features

- **Model comparison table** — per model (provider / model): sessions, tool calls, errors, error rate.
- **Top-5 tools / Top-5 error signatures** — per-model most-used tools with per-tool error counts; normalized high-frequency error patterns (e.g. `bash: [exit code: 137] OOM`) reveal where a model tends to fail.
- **Time-range filter** — All / Last 7 / Last 30 / Last 90 days / Today / Yesterday (anchored to the max date in the data, resilient to system clock drift).
- **Read-only** — analysis and display only, never mutates session data; the route validates a client header plus Origin/Referer and returns 403 on cross-origin requests.
- **Incremental caching** — per-file mtime baseline with background scanning (60s incremental / 24h full re-scan); while the initial scan is still running the route falls back to the last cache or mock data, so it never blocks.
- **Zero runtime dependencies** — pure Node.js.

## No DSH? Take a look anyway

Clone this repo and open `test/harness/index.html` in a browser — a zero-dependency render harness (mock data; `?scenario=mock|live|empty|error` switches scenarios, `?chrome=0` hides the harness bar).

## Development

```bash
npm test                     # node --test test/*.test.mjs
```

Local development: after cloning, use `pnpm add link:../path/to/dsh-cap-profile` in your profile. Client-only changes need a browser refresh; Node-side changes (`index.js` / `lib/*.js`) need a `dsh` restart.

## License

[MIT](LICENSE) © Ansonfishing
