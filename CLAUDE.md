# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

kiro-proxy is a Node.js proxy that bridges Kiro IDE with Amazon Q Developer. It reads Kiro's auth token from `~/.aws/sso/cache/kiro-auth-token.json`, proxies requests to Q Developer, and exposes OpenAI and Anthropic-compatible API endpoints so Claude models can be used via Claude Code.

## Running

```bash
# Start the server (default port 3456, override with PORT env var)
node server.js

# Or via the CLI command after npm link / global install
kiro-proxy
```

No build step, no tests, no linter configured. Pure ES modules (`"type": "module"`), requires Node >= 18.

## Architecture

Three files, each with a single responsibility:

- **server.js** — Express server exposing API endpoints. Handles request/response format translation and streaming (SSE). Caches the Q Developer client and reuses it when the token hasn't changed.
- **q-client.js** — Wraps `@aws/codewhisperer-streaming-client`. Converts Anthropic message format → CodeWhisperer format (messages, images, tools, thinking blocks). Streams response events back as an async generator.
- **token-reader.js** — Reads and refreshes Kiro auth tokens. Supports Social (Google/GitHub OAuth) and IdC (Enterprise/BuilderId) auth flows. Caches in memory, auto-refreshes 5 minutes before expiry, deduplicates concurrent refresh calls.

Request flow: Client → Express endpoint → `getAccessToken()` → `getClient()` (cached) → `convertMessages()` → `chatStream()`/`chat()` → format response back to client.

## API Endpoints

- `POST /v1/messages` — Anthropic Messages API (streaming + non-streaming)
- `POST /v1/chat/completions` — OpenAI Chat Completions API (streaming + non-streaming)
- `GET /v1/models` — List available models (Anthropic format)
- `GET /q/models` — Raw Q Developer model list
- `GET /health` — Token expiration status

## Key Implementation Details

- Token is read from `~/.aws/sso/cache/kiro-auth-token.json`, enriched with profile ARN from Kiro's profile cache
- Region and endpoint are derived from the profile ARN
- Tool use inputs arrive as streamed chunks that get accumulated and JSON-parsed at tool_use_end
- Image content supports base64, data URLs, and LangChain formats
- `KIRO_VERSION` env var (default `0.11.107`) controls the User-Agent version string
