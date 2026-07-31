[English](README_EN.md) | 中文

# kiro-proxy

让 [Kiro](https://kiro.dev) 订阅内含的 Claude 模型可以在 Claude Code 和 Codex CLI 中使用。

通过读取 Kiro 的认证 token，代理请求到新版 Kiro Runtime，暴露 OpenAI Responses 和 Anthropic 兼容的 API 接口。

## 前提

需要先安装并登录 Kiro，确保 `~/.aws/sso/cache/kiro-auth-token.json` 存在且未过期。

## 快速开始

```bash
npx kiro-proxy
```

服务默认监听 `http://localhost:3456`。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT`   | `3456` | 监听端口 |
| `PROXY_API_KEY` | 无 | 设置后所有请求需携带此 key 进行鉴权，未设置则不校验 |
| `HTTPS_PROXY` | 无 | HTTP/HTTPS 代理地址，如 `http://127.0.0.1:7890` |
| `KIRO_VERSION` | `1.0.231` | 发送到 Kiro 的客户端版本标识 |

当前实现使用与 Kiro `1.0.231` 相同的 Runtime 协议，并自动处理服务地址和系统提示词的兼容逻辑。

## 与 Claude Code 集成

Claude Code 默认使用 Anthropic 官方 model ID，需要通过环境变量映射到 Q Developer 的 model ID。

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "any",
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5"
  },
  "model": "sonnet"
}
```

`model` 可选值：`sonnet`、`opus`、`haiku`，添加 `[1m]` 后缀可启用 1M 上下文窗口（如 `"opus[1m]"`）。

> 注意：不要设置 `ANTHROPIC_MODEL` 环境变量，它会覆盖 `model` 字段，导致上下文窗口等配置失效。

## 与 Codex CLI 集成

在 `~/.codex/config.toml` 中添加：

```toml
model_provider = "kiro"
model = "gpt-5.6-sol"

[model_providers.kiro]
name = "Kiro Proxy"
base_url = "http://localhost:3456/v1"
env_key = "KIRO_PROXY_API_KEY"
wire_api = "responses"
```

启动 Codex 前设置任意 API key；如果代理配置了 `PROXY_API_KEY`，两者需保持一致：

```bash
export KIRO_PROXY_API_KEY=any
codex
```

## API

### GET /v1/models — 查询可用模型

```bash
curl http://localhost:3456/v1/models
```

### POST /v1/messages — Anthropic 兼容

```bash
# 非流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-5", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'

# 流式
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model": "claude-sonnet-5", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### POST /v1/responses — OpenAI Responses 兼容

```bash
# 非流式
curl http://localhost:3456/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.6-sol", "input": "Hello"}'

# 流式
curl http://localhost:3456/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.6-sol", "input": "Hello", "stream": true}'
```

### POST /v1/chat/completions — OpenAI Chat Completions 兼容

```bash
# 非流式
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'

# 流式（可选 stream_options.include_usage 在结束前返回 usage）
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}], "stream": true, "stream_options": {"include_usage": true}}'
```

支持 `tools` / `tool_calls` / `role: "tool"` 工具循环、data URL 图片、`reasoning_effort`；思考内容放在 `reasoning_content` 字段。不支持的字段（`n`、`logprobs`、`response_format`、`temperature` 等）会被忽略，`tool_choice` 仅 `none` 生效。

### GET /health

检查 token 状态及过期时间。

### GET /credits

查询积分消耗统计，支持 `period` 参数：

```bash
# 今日消耗（默认）
curl http://localhost:3456/credits

# 最近 7 天
curl http://localhost:3456/credits?period=7d

# 最近 30 天
curl http://localhost:3456/credits?period=30d

# 当前自然月
curl http://localhost:3456/credits?period=month

# 全部
curl http://localhost:3456/credits?period=all
```

## 代理设置

自 2026 年 5 月 1 日起，Kiro 上的 Claude 模型无法在中国大陆及港澳台地区使用。如果遇到 `Invalid model` 错误，请配置代理。

> 注意：代理节点需选择其他地区（如新加坡、泰国、韩国等）。

通过环境变量设置 HTTP 代理：

```bash
# 设置代理后启动
HTTPS_PROXY=http://127.0.0.1:7890 npx kiro-proxy
```

支持的环境变量：`HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`，优先级从左到右。

## 相关项目

- [kiro-web-search](https://github.com/Colin3191/kiro-web-search) — 将 Kiro 内置的联网搜索封装为 CLI，可在 Claude Code 等客户端中使用
