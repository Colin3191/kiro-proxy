# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

kiro-proxy is a Node.js proxy for Kiro Runtime. It reads Kiro's auth token from `~/.aws/sso/cache/kiro-auth-token.json`, calls the Kiro Runtime and control-plane services, and exposes OpenAI Responses and Anthropic-compatible API endpoints so Claude models can be used via Codex CLI and Claude Code.

## Running

```bash
# Install deps (lock file is pnpm)
pnpm install

# Start the server (default port 3456, override with PORT env var)
node server.js

# Or via the CLI command after npm link / global install
kiro-proxy
```

No build step or linter is configured. Tests run with `pnpm test`. Pure ES modules (`"type": "module"`), requires Node >= 18.

## Architecture

Source files, each with a single responsibility:

- **server.js** — Express server exposing API endpoints. Handles request/response format translation and streaming (SSE). Caches the Kiro Runtime client and reuses it when the token hasn't changed.
- **kiro-runtime-client.js** — Minimal implementation of the private Kiro Runtime client. Sends bearer-authenticated AWS JSON requests and parses Amazon EventStream frames.
- **q-client.js** — Converts Anthropic messages to Kiro Runtime format, repairs strict conversation ordering, and handles signed/redacted reasoning and tool events.
- **responses-api.js** — Converts OpenAI Responses input items and function calls to the shared Anthropic-style conversation model, and formats non-streaming/streaming Responses output.
- **chat-completions.js** — Same role for the OpenAI Chat Completions wire format: converts `messages`/`tool_calls`/`role: "tool"` into the Anthropic-style conversation model, and emits `chat.completion` / `chat.completion.chunk` payloads. Only `tool_choice: "none"` is honored; sampling fields the Kiro Runtime does not accept are ignored.
- **model-options.js** — Normalizes Anthropic/Responses thinking options and maps effort levels through each Kiro model's `additionalModelRequestFieldsSchema`.
- **token-reader.js** — Reads and refreshes Kiro auth tokens. Supports Social (Google/GitHub OAuth) and IdC (Enterprise/BuilderId) auth flows. Caches in memory, auto-refreshes 5 minutes before expiry, deduplicates concurrent refresh calls.
- **token-counter.js** — Heuristic token estimator for Anthropic-style content (text/tool_use/tool_result/thinking). Applies per-category multipliers (CJK, emoji, math symbols, URL delimiters, etc.). Used only for `usage.input_tokens` / `output_tokens` in responses — not billing.
- **usage-tracker.js** — Appends one JSONL line per request to `~/.kiro-proxy/usage/YYYY/MM/DD.jsonl` with `{ts, credits, model}`. Powers the `/credits` endpoint; supports `today | 7d | 30d | month | all` periods.
- **logger.js** — ANSI-colored console logger: `log()` for HTTP lines, `tagLog/tagWarn/tagError` for tagged messages, `logSummary()` for the per-request summary line with elapsed/context/tokens/credits.
- **proxy-config.js** — Reads `HTTPS_PROXY`/`HTTP_PROXY` and installs `undici`'s `EnvHttpProxyAgent` globally.

Request flow: Client → Express endpoint → `getAccessToken()` → `getClient()` (cached) → `convertMessages()` → `chatStream()`/`chat()` → format response back to client.

## API Endpoints

- `POST /v1/messages` — Anthropic Messages API (streaming + non-streaming)
- `POST /v1/responses` — OpenAI Responses API (streaming + non-streaming, function calls, reasoning replay)
- `POST /v1/chat/completions` — OpenAI Chat Completions API (streaming + non-streaming, tool calls, `reasoning_content`)
- `GET /v1/models` — List available models (Anthropic format)
- `GET /q/models` — Raw Kiro model list
- `GET /health` — Token expiration status
- `GET /credits?period=today|7d|30d|month|all` — Credit usage summary (requests, credits, byModel)

All endpoints are protected by a Bearer-token middleware if `PROXY_API_KEY` is set; otherwise open.

## Environment

- `PORT` — listen port (default `3456`)
- `PROXY_API_KEY` — if set, clients must send `Authorization: Bearer <key>`
- `KIRO_VERSION` — User-Agent version string (default `1.0.231`)
- `KIRO_RUNTIME_ENDPOINT` — optional Kiro Runtime endpoint override
- `KIRO_CONTROL_PLANE_ENDPOINT` — optional Kiro control-plane endpoint override
- `KIRO_SYSTEM_PROMPT_MODE` — `legacy` by default; set to `field` only when top-level system prompt injection is enabled upstream
- `HTTPS_PROXY` / `HTTP_PROXY` — outbound proxy for Kiro service calls (applied globally via undici)

## Reverse Engineering Reference

This project is reverse-engineered from Kiro's built-in agent plugin located at:

```
/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent
```

The bundled plugin (`dist/extension.js`) is the primary reference for understanding the Kiro Runtime protocol, message conversion, and tool-use event handling.

## Key Implementation Details

- Token is read from `~/.aws/sso/cache/kiro-auth-token.json`, enriched with profile ARN from Kiro's profile cache
- Region and endpoint are derived from the profile ARN
- Tool use inputs arrive as streamed chunks that get accumulated and JSON-parsed at tool_use_end
- Image content supports base64, data URLs, and LangChain formats
- `usage.input_tokens` / `output_tokens` in responses come from the heuristic `token-counter.js`, not from upstream. Actual billing uses `meteringUsage` reported by Kiro Runtime and is persisted by `usage-tracker.js`.
- SSE streaming in `/v1/messages` carefully sequences `thinking` → `text` → `tool_use` blocks, closing each before opening the next, and emits the full tool-use `input` as a single `input_json_delta` at `tool_use_end`.
