# Q Developer API Proxy

读取 Kiro 的认证 token（`~/.aws/sso/cache/kiro-auth-token.json`），代理请求到 Amazon Q Developer，暴露 OpenAI 兼容的 API。

## 使用

```bash
cd q-proxy
npm install
node server.js
```

默认监听 `http://localhost:3456`。

## 前提

需要先在 Kiro 中登录，确保 `~/.aws/sso/cache/kiro-auth-token.json` 存在且未过期。

## API

### POST /v1/chat/completions (OpenAI 兼容)

```bash
# 非流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "q-developer",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "q-developer",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### POST /v1/messages (Anthropic 兼容)

```bash
# 非流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "q-developer",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "q-developer",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### GET /v1/models

返回可用模型列表。

### GET /health

检查 token 状态。

## 配置

- `PORT` — 监听端口，默认 3456
