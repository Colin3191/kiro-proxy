[한국어](README_KR.md) | [中文](README.md) | English

# kiro-proxy

Proxy that exposes Claude models from your Kiro subscription as OpenAI/Anthropic-compatible API endpoints.

Reads Kiro auth tokens, proxies requests to Amazon Q Developer, and serves OpenAI and Anthropic-compatible APIs.

## Modes

### Local mode (default)

Reads token from `~/.aws/sso/cache/kiro-auth-token.json` on the local machine.

```bash
node server.js
```

### Multi-user mode

Clients pass their Kiro token via request headers. The server caches tokens in a SQLite DB and auto-refreshes them on expiry. Multiple users can use the proxy simultaneously with their own tokens.

```bash
# CLI flag
node server.js --multi-user

# Or environment variable
MULTI_USER=true node server.js
```

In multi-user mode, clients must include the following headers:

| Header | Required | Description |
|--------|----------|-------------|
| `X-Kiro-Access-Token` | Yes* | Current access token |
| `X-Kiro-Refresh-Token` | Yes* | Refresh token (used by server to auto-renew) |
| `X-Kiro-Auth-Method` | No | `social` or `IdC` |
| `X-Kiro-Profile-Arn` | No | Profile ARN |
| `X-Kiro-Region` | No | AWS region |
| `X-Kiro-Provider` | No | Provider type |

\* At least one is required. Provide both to enable auto-renewal.

Extracting tokens:

```bash
# Using the built-in script
./scripts/extract-token.sh headers   # Output -H flags
./scripts/extract-token.sh env       # Output export statements
./scripts/extract-token.sh curl      # Output single-line curl headers

# Use with curl
eval curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  $(./scripts/extract-token.sh curl) \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

Token flow:
1. First request: validate token and store in DB
2. Subsequent requests: use cached token from DB
3. On expiry: server auto-refreshes and updates DB
4. If refresh token itself expires: returns 401, client must submit a fresh token

## Prerequisites

Install and log in to Kiro so that `~/.aws/sso/cache/kiro-auth-token.json` exists.

## Quick Start

```bash
npx kiro-proxy
```

Default port: `http://localhost:3456`

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3456` | Listen port |
| `DATABRICKS_APP_PORT` | - | Overrides PORT when set |
| `PROXY_API_KEY` | - | When set, all requests require Bearer auth |
| `MULTI_USER` | `false` | `true` enables multi-user mode (same as `--multi-user` flag) |
| `TOKEN_DB_PATH` | `~/.kiro-proxy/tokens.db` | Token database path |
| `HTTPS_PROXY` | - | Outbound proxy URL |

## API

### POST /v1/messages — Anthropic-compatible

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

### POST /v1/chat/completions — OpenAI-compatible

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'
```

### GET /v1/models

List available models.

### GET /health

Check token status and expiration.

### GET /credits?period=today|7d|30d|all

Credit usage statistics.

## Claude Code Integration

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "any",
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5"
  },
  "model": "sonnet"
}
```

## Proxy Setup

If you encounter `Invalid model` errors:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 node server.js
```

## Origin

Forked from [Colin3191/kiro-proxy](https://github.com/Colin3191/kiro-proxy)
