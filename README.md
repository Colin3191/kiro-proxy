# kiro-proxy

读取 [Kiro](https://kiro.dev) 的认证 token，代理请求到 Amazon Q Developer，暴露 OpenAI 和 Anthropic 兼容的 API 接口。

## 前提

需要先安装并登录 Kiro，确保 `~/.aws/sso/cache/kiro-auth-token.json` 存在且未过期。

## 快速开始

```bash
npx @colin3191/kiro-proxy
```

服务默认监听 `http://localhost:3456`。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT`   | `3456` | 监听端口 |

## API

### GET /v1/models — 查询可用模型

```bash
curl http://localhost:3456/v1/models
```

### POST /v1/chat/completions — OpenAI 兼容

```bash
# 非流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}]}'

# 流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.6", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### POST /v1/messages — Anthropic 兼容

```bash
# 非流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'

# 流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-4.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### GET /health

检查 token 状态及过期时间。

## 与 Claude Code 集成

Claude Code 默认使用 Anthropic 官方 model ID，需要通过环境变量映射到 Q Developer 的 model ID。

在 `~/.claude/settings.json` 中添加：

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

配置后直接运行 `claude` 即可。
