English | [中文](README.md)

# kiro-proxy

Use the Claude models bundled with your [Kiro](https://kiro.dev) subscription in Claude Code.

Reads Kiro's auth token, proxies requests to Amazon Q Developer, and exposes OpenAI and Anthropic-compatible API endpoints.

## Prerequisites

Install and log in to Kiro so that `~/.aws/sso/cache/kiro-auth-token.json` exists and is valid.

## Quick Start

```bash
npx @colin3191/kiro-proxy
```

Server listens on `http://localhost:3456` by default.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3456` | Listen port |

## API

### GET /v1/models — List available models

```bash
curl http://localhost:3456/v1/models
```

### POST /v1/chat/completions — OpenAI-compatible

```bash
# Non-streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'

# Streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### POST /v1/messages — Anthropic-compatible

```bash
# Non-streaming
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'

# Streaming
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### GET /health

Check token status and expiration.

## Claude Code Integration

Claude Code uses Anthropic's official model IDs by default. Map them to Q Developer model IDs via environment variables.

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "any",
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5"
  }
}
```

## Related Projects

- [kiro-web-search](https://github.com/Colin3191/kiro-web-search) — MCP server exposing Kiro's web search for use in Claude Code and other clients
