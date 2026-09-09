<div align="center">

# 📼 LLM-VCR

**Record LLM API responses once. Replay them forever. Zero API cost for everyone who clones your repo.**

Record/Replay proxy + Studio UI for OpenAI-compatible LLM APIs — deterministic tests, drift detection, no API keys in CI.

[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](#-testing)
[![Node](https://img.shields.io/badge/node-18%2B-339933?logo=nodedotjs&logoColor=white)](#requirements)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#quick-start-2-minutes)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#requirements)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

`llm` · `openai` · `testing` · `proxy` · `developer-tools`

![LLM-VCR Studio Demo](https://github.com/ahaomar/llm-vcr/blob/main/.github/assets/demo.gif)

</div>

---

## Why does this exist?

Every team integrating LLM APIs hits the same three walls:

| Problem | Reality |
|---|---|
| 💸 **Cost** | Running your test suite against OpenAI/Anthropic on every commit = real money, every day |
| 🎲 **Flakiness** | LLMs are non-deterministic. The same prompt gives different answers — tests fail randomly |
| 🔑 **Secrets** | CI needs a real API key. Keys leak. Rotating them breaks pipelines |
| 🐉 **Silent drift** | Model updates change outputs overnight and break your app with zero warning |

**`llm-vcr` fixes all four.** It's an HTTP proxy that sits between your app and the LLM API:

```
RECORD (you, once)           REPLAY (everyone, forever)          DRIFT (scheduled)

 app ──▶ vcr ──▶ real API     app ──▶ vcr ──▶ cassette file       app ──▶ vcr ──▶ real API
          │                                                             │
          └─ saves cassette        no key · no network · no cost        diff vs cassette
                                                       deterministic          drift report
```

Named after the classic [VCR pattern](https://github.com/vcr/vcr) (record once, play back forever) — purpose-built for the LLM era with streaming, token tracking, and drift detection.

---

## Quick Start (2 minutes)

> No API key. No signup. The repo ships with pre-recorded cassettes.

### Option A — Docker (recommended)

```bash
git clone https://github.com/ahaomar/llm-vcr.git
cd llm-vcr
docker compose up
```

Watch the demo app make two LLM calls — served entirely from cassettes:

```
non-stream  [200] x-vcr=replayed
  content: Hello! You said: Say hello in one short sentence.
stream      [200] x-vcr=replayed
  content: Counting: one two three four five.
```

### Option B — Plain Node.js

```bash
git clone https://github.com/ahaomar/llm-vcr.git
cd llm-vcr
VCR_MODE=replay node bin/vcr.js
```

### Open the Studio 🎛️

**→ http://localhost:9090/studio**

| Panel | What it does |
|---|---|
| 🎚️ **Mode switch** | Record / Replay / Drift with one click — hot-switching, no restarts |
| 📊 **Stats row** | Live counters: replayed, recorded, missed, drift matches/diffs |
| 📡 **Live traffic** | Every LLM call streams in with verdict badges + token counts |
| 🗂️ **Cassettes** | Browse, inspect (full JSON), delete recordings |
| 🔌 **Connect your agent** | Generates ready-to-use config for opencode / Cursor / curl |
| ∿ **Drift report** | Colorized diffs of live vs recorded model output |

### See it work (30 seconds)

```bash
# terminal 1: server running (from above)

# terminal 2: hit the proxy — served from disk, no API
node examples/demo.js
```

Watch the **Live traffic** panel light up with green `replayed` badges.

---

## How it works: The Record → Commit → Replay workflow

This is the core idea. **You record once; everyone who clones your repo replays forever — with no API key, ever.**

### Step 1 — Record (you, once — needs API access)

Point the proxy at your real provider and run your app/tests against it:

```bash
# start the proxy in record mode
VCR_MODE=record \
VCR_UPSTREAM=https://api.openai.com \
npm start

# in another terminal — point YOUR app at the proxy
OPENAI_BASE_URL=http://localhost:9090/v1 npm test
```

Every call passes through to the real API (normal costs apply to *you*) and is saved as a **cassette** — a plain JSON file with the request, response, and token usage. Secrets are scrubbed automatically.

> Prefer clicking to typing? Use the Studio: open http://localhost:9090/studio → click **Record** → paste your upstream URL → run your app. Watch cassettes appear live.

### Step 2 — Commit the cassettes

```bash
git add cassettes/
git commit -m "test: record LLM cassettes"
```

Cassettes are plain JSON — reviewable in PRs, diffable, hand-editable.

### Step 3 — Replay (CI, teammates, forever)

```bash
VCR_MODE=replay npm start
OPENAI_BASE_URL=http://localhost:9090/v1 npm test
```

**No key. No network. No cost. Deterministic — byte-for-byte identical responses, every run.** Stream responses replay chunk-for-chunk.

### Step 4 — Drift-check (scheduled, e.g. weekly CI job)

Detect when the provider silently changes model behavior:

```bash
VCR_MODE=drift \
VCR_UPSTREAM=https://api.openai.com \
VCR_REPORT=drift-report.md \
npm start

OPENAI_BASE_URL=http://localhost:9090/v1 npm test
# → open drift-report.md: exactly what changed, line by line
```

Example drift report output:

```diff
## POST /v1/chat/completions (a7ecfcfa479e)
**Verdict: DIFF**
- Hello there, and welcome!
+ Hello there! It's nice to meet you.
```

---

## Using with AI coding agents

`llm-vcr` works with any OpenAI-compatible client. The Studio's **Connect your agent** panel writes these configs for you.

### opencode

```jsonc
// opencode.json
{
  "provider": {
    "llm-vcr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llm-vcr replay (local proxy)",
      "options": {
        "baseURL": "http://localhost:9090/v1",
        "apiKey": "unused-in-replay-mode"
      },
      "models": {
        "gpt-4o-mini": { "name": "gpt-4o-mini via llm-vcr" }
      }
    }
  }
}
```

Start opencode, pick the `llm-vcr` provider, chat away — every request is served from your cassettes.

### Cursor

Settings → Models → set **OpenAI Base URL** to `http://localhost:9090/v1`, API key to any placeholder, and enable your model.

### Any other tool (aider, Continue, your own code)

Anything that accepts an OpenAI-compatible base URL works. Point it at `http://localhost:9090/v1`.

> **Note on matching:** requests are matched by their **exact body** (method + path + JSON, order-independent). A slightly different prompt = a different key. In replay mode a miss returns `404 vcr_cassette_missing` — record more to cover more. (Fuzzy matching is on the roadmap.)

---

## Features

- 🎛️ **Studio UI** — browser dashboard: mode switching, live traffic, cassette browser, config generator, drift viewer
- 🎯 **3 modes** — `record` (pass-through + save), `replay` (serve from cassettes), `drift` (pass-through + diff)
- ⚡ **Streaming (SSE) support** — recorded and replayed chunk-for-chunk
- 🔒 **Secret scrubbing** — API keys, bearer tokens, AWS/GitHub/Google credentials masked before writing
- 🔀 **Hybrid mode** — `VCR_ON_MISS=record`: replay what you have, record-and-pass-through what you don't
- 🎚️ **Hot mode switching** — change modes from the UI or API, no restarts
- 🔢 **Token tracking** — real usage from the API, approximated when absent
- 🪶 **Zero dependencies** — one Node process. No `npm install`. Nothing to audit.

## Requirements

- Node.js 18+ (or Docker) — that's it

---

## Configuration

All config via environment variables:

| Env var | Default | Description |
|---|---|---|
| `VCR_MODE` | `replay` | `record` \| `replay` \| `drift` |
| `VCR_UPSTREAM` | — | Provider base URL for record/drift (e.g. `https://api.openai.com`) — **no trailing `/v1`** |
| `VCR_PORT` | `9090` | Proxy + Studio port |
| `VCR_CASSETTES` | `./cassettes` | Cassette directory |
| `VCR_ON_MISS` | `error` | In replay: `error` (404) or `record` (pass-through + save the miss) |
| `VCR_REPORT` | `.vcr-drift-report.md` | Drift report output path |
| `VCR_UPSTREAM_TIMEOUT_MS` | `120000` | Upstream timeout in record/drift |

Or switch modes at runtime — no restart needed:

```bash
# switch to record mode with an upstream, via the Studio API
curl -X POST http://localhost:9090/__vcr/studio/api/mode \
  -H 'content-type: application/json' \
  -d '{"mode":"record","upstream":"https://api.openai.com"}'
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST {any-path}` | Proxied / replayed / drift-checked — your app talks here |
| `GET /__vcr/health` | Mode, stats, cassette count |
| `GET /studio` | The Studio UI |
| `GET /__vcr/studio/api/state` | Current mode, upstream, stats |
| `POST /__vcr/studio/api/mode` | Hot-switch mode `{ "mode": "record", "upstream": "..." }` |
| `GET /__vcr/studio/api/cassettes` | List cassettes + token totals |
| `GET /__vcr/studio/api/log/stream` | Live traffic (SSE) |
| `POST /__vcr/studio/api/config` | Generate client config (opencode/cursor/curl) |

Every proxied response carries an **`x-vcr` header**: `replayed` · `recorded` · `drift-match` · `drift-diff` · `drift-no_cassette` — so your tests can assert which path was taken.

---

## How matching works

Requests are matched by `SHA-256(method + path + canonical-JSON-body)` (first 12 hex chars):

- ✅ JSON key order doesn't matter — bodies are canonicalized (keys sorted recursively) before hashing
- ✅ Whitespace outside strings is normalized
- ❌ Different prompt, model, or params = different key = intentional miss

This makes replay **deterministic**: the same logical request always finds the same cassette.

## Secret scrubbing

Before any cassette is written to disk:

| What | Becomes |
|---|---|
| Values of keys matching `authorization`, `api-key`, `token`, `secret`, `password`, `cookie` | `[SCRUBBED]` |
| OpenAI `sk-…` / Anthropic `sk-ant-…` key formats | `[SCRUBBED:openai-key]` / `[SCRUBBED:anthropic-key]` |
| Bearer tokens, AWS `AKIA…`, GitHub `ghp_…`, Google `AIza…` | `[SCRUBBED:<type>]` |

Applies to request bodies, response bodies, and headers. **Still review cassettes before committing** — you own your repo.

## Cassette format

Plain JSON, one file per recorded request:

```json
{
  "version": 1,
  "key": "a1b2c3d4e5f6",
  "recordedAt": "2026-09-08T10:00:00.000Z",
  "streaming": false,
  "request":  { "method": "POST", "path": "/v1/chat/completions", "body": { "model": "gpt-4o-mini", "messages": ["..."] } },
  "response": { "status": 200, "headers": { "content-type": "application/json" }, "body": { "choices": ["..."] } },
  "usage":    { "prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21 }
}
```

---

## Testing

The test suite is fully self-contained — it spins up a mock OpenAI server, records against it, replays, drift-checks, and verifies scrubbing. **No API key. No network.**

```bash
npm test
```

```
ok - record: non-streaming call is saved as cassette
ok - record: streaming call is saved as cassette
ok - record: secret scrubbing masks keys in cassettes
ok - replay: non-streaming cassette replays byte-identical content
ok - replay: streaming cassette replays full SSE sequence
ok - replay: different body = different key = 404 miss
ok - replay: key order in body does not change match
... (14 total)
PASSED: 14  FAILED: 0
```

GitHub Actions runs the suite plus a Docker smoke test on every push (see `.github/workflows/ci.yml`).

## Project structure

```
llm-vcr/
├── bin/vcr.js          CLI entry point
├── src/
│   ├── proxy.js        Core proxy: record / replay / drift engine
│   ├── studio.js       Studio backend: REST API + static serving
│   ├── canonical.js    Request canonicalization + hashing
│   ├── cassette.js     Cassette load/save
│   ├── scrub.js        Secret scrubbing
│   ├── drift.js        Response diffing
│   └── eventlog.js     Live traffic event bus
├── studio/             Studio frontend (vanilla JS/CSS, no build step)
├── cassettes/          Shipped demo cassettes
├── examples/demo.js    Demo app: 2 LLM calls, works with zero setup
├── test/               Self-contained test suite + mock OpenAI server
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## Use cases

- 🧪 **Deterministic integration tests** for AI features — no flaky failures, no per-run cost
- 🤖 **CI without secrets** — test suites run with zero API credentials
- 📐 **Snapshot-testing agent behavior** — lock in what your agent does per prompt, review changes in PRs
- 🐉 **Model drift monitoring** — weekly job diffs live provider output against recorded cassettes
- 🎓 **Demos and workshops** — build a full AI demo that runs offline, forever
- 🧳 **Offline development** — code on a plane; your AI features still work

## Roadmap

- [ ] Fuzzy/partial matching (match on messages, ignore temperature jitter)
- [ ] Anthropic + Gemini native cassette adapters
- [ ] Cassette TTL + one-command re-record
- [ ] Multiple responses per key (rotate/fuzz)
- [ ] Token cost estimation per model
- [ ] Export/import cassette bundles

## Contributing

Issues and PRs welcome. The codebase is deliberately small (zero dependencies, no build step) — a good first contribution target.

```bash
git clone https://github.com/ahaomar/llm-vcr.git
cd llm-vcr
npm test        # everything must stay green
```

## License

[MIT](LICENSE) © Muhammad Omar Farooq
